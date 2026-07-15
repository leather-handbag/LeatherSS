import { adminClient } from "../_shared/client.ts";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { ingestSyncPage } from "../_shared/ingest.ts";
import { syncPage, type Platform } from "../_shared/training.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function refreshDueCatalog() {
  const admin = adminClient();
  const { data: platform, error: claimError } = await admin.rpc("claim_training_catalog_sync");
  if (claimError || !platform) return;
  try {
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/training-catalog-sync`;
    const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "x-worker-secret": secret, "Content-Type": "application/json" }, body: JSON.stringify({ platform }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `catalog function returned ${response.status}`);
    await admin.rpc("finish_training_catalog_sync", { platform_name: platform, succeeded: true, error_message: "" });
  } catch (error) {
    await admin.rpc("finish_training_catalog_sync", { platform_name: platform, succeeded: false, error_message: (error as Error).message });
  }
}

async function processOne(workerId: string) {
  const admin = adminClient();
  const { data: job, error: claimError } = await admin.rpc("claim_training_sync_job", { worker_name: workerId });
  if (claimError) throw claimError;if (!job) return null;
  const started = performance.now();
  const { data: account, error: accountError } = await admin.from("external_accounts").select("*").eq("id", job.external_account_id).maybeSingle();
  if (accountError || !account) {
    await admin.rpc("finish_training_sync_job", { target_job: job.id, outcome: "failed", failure_code: "account_missing", failure_message: accountError?.message || "external account was removed" });
    return { job: job.id, outcome: "failed", code: "account_missing" };
  }
  if (account.platform === "luogu" || account.status === "disabled") {
    await admin.rpc("finish_training_sync_job", { target_job: job.id, outcome: "failed", failure_code: "platform_unavailable", failure_message: "provider disabled pending official permission" });
    return { job: job.id, platform: account.platform, outcome: "failed", code: "platform_unavailable" };
  }
  try {
    const { data: waitMs, error: leaseError } = await admin.rpc("acquire_training_platform_lease", { platform_name: account.platform });if (leaseError) throw leaseError;
    if (Number(waitMs) > 0) await pause(Math.min(Number(waitMs), 5000));
    const page = await syncPage({ platform: account.platform as Platform, handle: account.handle, external_user_id: account.external_user_id }, job.cursor || account.sync_cursor || {});
    const counts = await ingestSyncPage(admin, account, page);
    const now = new Date().toISOString();
    const nextHours = page.more ? 0 : 6;
    const { error: updateError } = await admin.from("external_accounts").update({ sync_cursor: page.cursor, status: "active", last_sync_at: now, last_success_at: now, data_through: page.dataThrough || account.data_through, next_sync_at: new Date(Date.now() + nextHours * 3600000).toISOString(), last_error_code: "", last_error_message: "", updated_at: now }).eq("id", account.id);if (updateError) throw updateError;
    await admin.rpc("finish_training_sync_job", { target_job: job.id, outcome: "succeeded", next_cursor: page.cursor, fetched_count: counts.fetched, inserted_count: counts.changed, duration_ms: Math.round(performance.now() - started), more_pages: page.more });
    if (!page.more) {
      await admin.rpc("refresh_training_user", { target_user: account.user_id });
      await admin.from("expedition_logs").insert({ user_id: account.user_id, type: "sync", title: `${account.platform} 远征记录已更新`, message: `本次读取 ${counts.fetched} 条公开提交，新增 ${counts.changed} 条记录。`, detail: { platform: account.platform, fetched: counts.fetched, inserted: counts.changed } });
    }
    return { job: job.id, platform: account.platform, outcome: "succeeded", fetched: counts.fetched, inserted: counts.changed, more: page.more };
  } catch (error) {
    const value = error as { message?: string; code?: string; retryable?: boolean };
    const code = value.code || "sync_error";const message = String(value.message || "sync failed").slice(0, 500);
    await admin.from("external_accounts").update({ status: code === "not_found" ? "reverify_required" : "degraded", last_sync_at: new Date().toISOString(), last_error_code: code, last_error_message: message, next_sync_at: new Date(Date.now() + 6 * 3600000).toISOString(), updated_at: new Date().toISOString() }).eq("id", account.id);
    await admin.rpc("finish_training_sync_job", { target_job: job.id, outcome: "failed", next_cursor: job.cursor || {}, duration_ms: Math.round(performance.now() - started), failure_code: code, failure_message: message });
    return { job: job.id, platform: account.platform, outcome: "failed", code, message };
  }
}

Deno.serve(async req => {
  const options = handleOptions(req);if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  try {
    const admin = adminClient();
    const { data: tokenValid, error: tokenError } = await admin.rpc("verify_training_worker_token", { provided_token: req.headers.get("x-worker-secret") || "" });
    if (tokenError || tokenValid !== true) return jsonResponse({ error: "worker authorization failed" }, 401);
    await admin.rpc("enqueue_due_training_syncs", { limit_count: 50 });
    const catalogTask = refreshDueCatalog();
    const runtime = globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } };
    if (runtime.EdgeRuntime) runtime.EdgeRuntime.waitUntil(catalogTask); else await catalogTask;
    const workerId = `edge-${crypto.randomUUID().slice(0, 8)}`;
    const results = [];
    for (let i = 0; i < 3; i++) { const result = await processOne(workerId);if (!result) break;results.push(result); }
    return jsonResponse({ workerId, processed: results.length, results });
  } catch (error) {
    const value = error as { message?: string; status?: number };
    return jsonResponse({ error: value.message || "worker failed" }, value.status || 500);
  }
});
