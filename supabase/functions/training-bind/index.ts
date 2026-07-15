import { adminClient, authenticatedUser } from "../_shared/client.ts";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { fallbackChallenge, hmacCode, inspectProfile, newVerificationCode, normalizeHandle, profileContainsChallenge, type Platform, verifySubmissionChallenge } from "../_shared/training.ts";

const placement: Record<Platform, string> = { codeforces: "Codeforces 的 Organization", atcoder: "AtCoder 的 Affiliation" };
const unavailable = () => jsonResponse({
  error: "洛谷暂未提供允许使用的提交记录接口，Leather 已暂停相关功能。",
  code: "platform_unavailable",
}, 503);

Deno.serve(async req => {
  const options = handleOptions(req);if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  try {
    const { user } = await authenticatedUser(req);
    const admin = adminClient();
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "start");

    if (action === "start" || action === "fallback") {
      const requestedPlatform = String(body.platform || "");
      if (requestedPlatform === "luogu") return unavailable();
      if (!["codeforces", "atcoder"].includes(requestedPlatform)) return jsonResponse({ error: "不支持的平台" }, 400);
      const platform = requestedPlatform as Platform;
      const handle = normalizeHandle(platform, body.handle);
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error: countError } = await admin.from("binding_challenges").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", since);
      if (countError) throw countError;if ((count || 0) >= 5) return jsonResponse({ error: "绑定尝试过于频繁，请一小时后再试" }, 429);
      const profile = await inspectProfile(platform, handle);
      const { data: conflict, error: conflictError } = await admin.from("external_accounts").select("id").eq("platform", platform).eq("external_user_id", profile.externalUserId).maybeSingle();
      if (conflictError) throw conflictError;if (conflict) return jsonResponse({ error: "该平台账号已经被绑定" }, 409);
      await admin.from("binding_challenges").update({ status: "cancelled" }).eq("user_id", user.id).eq("platform", platform).eq("status", "pending");
      const method = action === "fallback" ? "submission_challenge" : "profile_code";
      const code = method === "profile_code" ? newVerificationCode() : "";
      const challenge = method === "submission_challenge" ? fallbackChallenge(platform) : {};
      const minutes = method === "submission_challenge" ? Number(challenge.windowMinutes) : 20;
      const { data, error } = await admin.from("binding_challenges").insert({
        user_id: user.id, platform, requested_handle: handle, normalized_handle: profile.normalizedHandle,
        external_user_id: profile.externalUserId, canonical_handle: profile.handle, avatar_url: profile.avatarUrl,
        profile_url: profile.profileUrl, method, code_hash: code ? await hmacCode(code) : "", payload: challenge,
        expires_at: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
      }).select("id,method,payload,expires_at").single();
      if (error) throw error;
      return jsonResponse({ challengeId: data.id, method, code: code || undefined, placement: method === "profile_code" ? placement[platform] : undefined, challenge: method === "submission_challenge" ? challenge : undefined, expiresAt: data.expires_at, profile: { platform, handle: profile.handle, avatarUrl: profile.avatarUrl, profileUrl: profile.profileUrl } });
    }

    if (action === "verify") {
      const challengeId = String(body.challengeId || "");
      const { data: challenge, error } = await admin.from("binding_challenges").select("*").eq("id", challengeId).eq("user_id", user.id).eq("status", "pending").maybeSingle();
      if (error) throw error;if (!challenge) return jsonResponse({ error: "验证任务不存在或已经完成" }, 404);
      if (challenge.platform === "luogu") {
        await admin.from("binding_challenges").update({ status: "cancelled" }).eq("id", challenge.id);
        return unavailable();
      }
      if (Date.parse(challenge.expires_at) <= Date.now()) { await admin.from("binding_challenges").update({ status: "expired" }).eq("id", challenge.id);return jsonResponse({ error: "验证码已经过期，请重新开始绑定" }, 410); }
      const windowFresh = challenge.attempt_window_started_at && Date.now() - Date.parse(challenge.attempt_window_started_at) < 60000;
      const windowAttempts = windowFresh ? Number(challenge.window_attempts || 0) : 0;
      if (windowAttempts >= 3) return jsonResponse({ error: "验证过于频繁，请一分钟后重试" }, 429);
      await admin.from("binding_challenges").update({ attempts: Number(challenge.attempts || 0) + 1, attempt_window_started_at: windowFresh ? challenge.attempt_window_started_at : new Date().toISOString(), window_attempts: windowAttempts + 1, last_attempt_at: new Date().toISOString() }).eq("id", challenge.id);
      const profile = await inspectProfile(challenge.platform, challenge.canonical_handle);
      const verified = challenge.method === "profile_code" ? await profileContainsChallenge(profile, challenge.code_hash) : await verifySubmissionChallenge(profile, challenge.payload || {}, challenge.created_at);
      if (!verified) return jsonResponse({ error: challenge.method === "profile_code" ? `尚未在${placement[challenge.platform as Platform]}发现验证码` : "尚未发现符合时间窗口的编译错误提交", pending: true }, 422);
      const { data: account, error: accountError } = await admin.from("external_accounts").insert({ user_id: user.id, platform: challenge.platform, handle: profile.handle, normalized_handle: profile.normalizedHandle, external_user_id: profile.externalUserId, avatar_url: profile.avatarUrl, profile_url: profile.profileUrl, verification_method: challenge.method }).select("*").single();
      if (accountError) {
        if (/unique|duplicate/i.test(accountError.message)) return jsonResponse({ error: "该平台账号已经被绑定" }, 409);
        throw accountError;
      }
      await admin.from("binding_challenges").update({ status: "verified", verified_at: new Date().toISOString(), code_hash: "" }).eq("id", challenge.id);
      const { data: job, error: jobError } = await admin.from("training_sync_jobs").insert({ user_id: user.id, external_account_id: account.id, platform: account.platform, kind: "initial", requested_by: "binding", priority: 100 }).select("id,status").single();
      if (jobError) throw jobError;
      await admin.from("expedition_logs").insert({ user_id: user.id, type: "binding", title: `已连接 ${account.platform}`, message: `${account.handle} 已通过所有权验证，历史远征记录正在回填。`, detail: { platform: account.platform } });
      await admin.rpc("refresh_training_user", { target_user: user.id });
      return jsonResponse({ verified: true, account: { id: account.id, platform: account.platform, handle: account.handle, avatarUrl: account.avatar_url, status: account.status }, job });
    }

    if (action === "unbind") {
      const accountId = String(body.accountId || "");
      const { data: account, error } = await admin.from("external_accounts").select("*").eq("id", accountId).eq("user_id", user.id).maybeSingle();
      if (error) throw error;if (!account) return jsonResponse({ error: "绑定不存在" }, 404);
      // Disabled legacy accounts may still be removed by their owner, but are
      // never verified, refreshed, or returned by active provider DTOs.
      await admin.from("training_sync_jobs").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("external_account_id", account.id).in("status", ["queued", "running"]);
      const { error: deleteError } = await admin.from("external_accounts").delete().eq("id", account.id).eq("user_id", user.id);if (deleteError) throw deleteError;
      await admin.rpc("refresh_training_user", { target_user: user.id });
      return jsonResponse({ unbound: true, platform: account.platform });
    }

    return jsonResponse({ error: "未知操作" }, 400);
  } catch (error) {
    const value = error as { message?: string; status?: number; code?: string };
    return jsonResponse({ error: value.message || "绑定服务暂时不可用", code: value.code || "binding_error" }, value.status || 500);
  }
});
