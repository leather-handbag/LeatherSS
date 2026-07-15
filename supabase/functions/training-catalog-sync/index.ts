import { adminClient, requireWorkerSecret } from "../_shared/client.ts";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { upsertProblems } from "../_shared/ingest.ts";
import { mapDifficulty, type NormalizedProblem, type Platform } from "../_shared/training.ts";

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Leather-Algorithm-Expedition/1.0", Accept: "application/json" } });
    if (!response.ok) throw new Error(`catalog source returned HTTP ${response.status}`);
    return await response.json() as T;
  } finally { clearTimeout(timer); }
}

async function codeforcesCatalog(): Promise<NormalizedProblem[]> {
  const data = await getJson<{ status: string; result?: { problems?: Array<Record<string, unknown>> } }>("https://codeforces.com/api/problemset.problems");
  if (data.status !== "OK") throw new Error("Codeforces catalog request failed");
  return (data.result?.problems || []).flatMap(problem => {
    const contest = String(problem.contestId || "");const index = String(problem.index || "");if (!contest || !index) return [];
    const raw = Number.isFinite(Number(problem.rating)) ? Number(problem.rating) : null;const difficulty = mapDifficulty("codeforces", raw);
    return [{ platform: "codeforces" as Platform, externalProblemId: `${contest}${index}`, contestId: contest, index, title: String(problem.name || `${contest}${index}`).slice(0, 240), url: `https://codeforces.com/problemset/problem/${contest}/${encodeURIComponent(index)}`, rawDifficulty: raw, normalizedDifficulty: difficulty.normalized, mapCode: difficulty.mapCode, rawTags: Array.isArray(problem.tags) ? problem.tags.map(String) : [] }];
  });
}

async function atcoderCatalog(): Promise<NormalizedProblem[]> {
  const [problems, models] = await Promise.all([
    getJson<Array<Record<string, unknown>>>("https://kenkoooo.com/atcoder/resources/problems.json"),
    getJson<Record<string, Record<string, unknown>>>("https://kenkoooo.com/atcoder/resources/problem-models.json"),
  ]);
  return problems.map(problem => {
    const id = String(problem.id || "");const contest = String(problem.contest_id || "");
    const model = models[id] || {};const raw = Number.isFinite(Number(model.difficulty)) ? Number(model.difficulty) : null;const difficulty = mapDifficulty("atcoder", raw);
    return { platform: "atcoder" as Platform, externalProblemId: id, contestId: contest, index: String(problem.problem_index || ""), title: String(problem.name || problem.title || id).slice(0, 240), url: `https://atcoder.jp/contests/${encodeURIComponent(contest)}/tasks/${encodeURIComponent(id)}`, rawDifficulty: raw, normalizedDifficulty: difficulty.normalized, mapCode: difficulty.mapCode, rawTags: [], metadata: { experimental: Boolean(model.is_experimental) } };
  }).filter(problem => problem.externalProblemId && problem.contestId);
}

Deno.serve(async req => {
  const options = handleOptions(req);if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  try {
    requireWorkerSecret(req);
    const body = await req.json().catch(() => ({}));const platform = String(body.platform || "atcoder");
    if (!['codeforces','atcoder'].includes(platform)) return jsonResponse({ error: "unsupported catalog platform" }, 400);
    const problems = platform === "codeforces" ? await codeforcesCatalog() : await atcoderCatalog();
    const admin = adminClient();let processed = 0;
    for (let i = 0; i < problems.length; i += 500) { await upsertProblems(admin, problems.slice(i, i + 500));processed += Math.min(500, problems.length - i); }
    return jsonResponse({ platform, processed, completedAt: new Date().toISOString() });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message || "catalog sync failed" }, 500);
  }
});
