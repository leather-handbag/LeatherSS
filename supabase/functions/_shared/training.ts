// Only providers with an approved, public submission source belong in this
// active union.  The dormant Luogu reference implementation lives under
// functions/_disabled and is deliberately not imported by any Edge Function.
export type Platform = "codeforces" | "atcoder";

export type ExternalProfile = {
  platform: Platform;
  handle: string;
  normalizedHandle: string;
  externalUserId: string;
  avatarUrl: string;
  profileUrl: string;
  verificationText: string;
};

export type NormalizedProblem = {
  platform: Platform;
  externalProblemId: string;
  contestId: string;
  index: string;
  title: string;
  url: string;
  rawDifficulty: number | null;
  normalizedDifficulty: number | null;
  mapCode: string | null;
  rawTags: string[];
  metadata?: Record<string, unknown>;
};

export type NormalizedSubmission = {
  externalSubmissionId: string;
  problemExternalId: string;
  verdict: string;
  accepted: boolean;
  language: string;
  submittedAt: string;
  timeMs: number | null;
  memoryKb: number | null;
  metadata?: Record<string, unknown>;
};

export type SyncPage = {
  problems: NormalizedProblem[];
  submissions: NormalizedSubmission[];
  cursor: Record<string, unknown>;
  more: boolean;
  dataThrough: string | null;
};

const agents = {
  codeforces: "Leather-Algorithm-Expedition/1.0 (+public submission metadata)",
  atcoder: "Leather-Algorithm-Expedition/1.0",
};

function clean(value: unknown, max = 300) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function htmlText(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim();
}

async function fetchText(url: string, platform: Platform, timeoutMs = 15000, extra: HeadersInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": agents[platform], Accept: "application/json,text/html;q=0.9,*/*;q=0.5", ...extra },
    });
    const text = await response.text();
    if (response.status === 429) throw Object.assign(new Error(`${platform} rate limited the request`), { code: "rate_limited", retryable: true });
    if (response.status === 403) throw Object.assign(new Error(`${platform} refused public access`), { code: "source_forbidden", retryable: true });
    if (!response.ok) throw Object.assign(new Error(`${platform} returned HTTP ${response.status}`), { code: response.status === 404 ? "not_found" : "source_http_error", retryable: response.status >= 500 });
    return { response, text };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw Object.assign(new Error(`${platform} request timed out`), { code: "timeout", retryable: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, platform: Platform, timeoutMs = 15000): Promise<T> {
  const { text } = await fetchText(url, platform, timeoutMs);
  try { return JSON.parse(text) as T; }
  catch { throw Object.assign(new Error(`${platform} returned an unexpected response`), { code: "parser_changed", retryable: true }); }
}

export function normalizeHandle(platform: Platform, value: unknown) {
  const raw = clean(value, 40);
  const patterns: Record<Platform, RegExp> = {
    codeforces: /^[A-Za-z0-9_.-]{3,24}$/,
    atcoder: /^[A-Za-z0-9_]{1,40}$/,
  };
  if (!patterns[platform].test(raw)) throw Object.assign(new Error("用户名格式不符合该平台规则"), { status: 400, code: "invalid_handle" });
  return platform === "codeforces" ? raw.toLowerCase() : raw;
}

function atcoderDisplayDifficulty(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value < 400 ? 400 / Math.exp(1 - value / 400) : value);
}

export function mapDifficulty(platform: Platform, raw: number | null) {
  if (raw == null || !Number.isFinite(raw)) return { normalized: null, mapCode: null };
  let value = Math.round(raw);
  if (platform === "atcoder") value = atcoderDisplayDifficulty(value) ?? value;
  const mapCode = value < 1100 ? "plains" : value < 1400 ? "bronze" : value < 1700 ? "silver" : value < 2000 ? "gold" : value < 2400 ? "platinum" : value < 2800 ? "master" : "legend";
  return { normalized: value, mapCode };
}

export async function inspectProfile(platform: Platform, requestedHandle: string): Promise<ExternalProfile> {
  const normalized = normalizeHandle(platform, requestedHandle);
  if (platform === "codeforces") {
    const payload = await fetchJson<{ status: string; comment?: string; result?: Array<Record<string, unknown>> }>(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(normalized)}`, platform);
    const user = payload.result?.[0];
    if (payload.status !== "OK" || !user) throw Object.assign(new Error("没有找到这个 Codeforces 用户"), { status: 404, code: "not_found" });
    const handle = clean(user.handle, 40);
    return { platform, handle, normalizedHandle: handle.toLowerCase(), externalUserId: handle.toLowerCase(), avatarUrl: clean(user.titlePhoto || user.avatar, 1000), profileUrl: `https://codeforces.com/profile/${encodeURIComponent(handle)}`, verificationText: clean(user.organization, 500) };
  }
  if (platform === "atcoder") {
    const url = `https://atcoder.jp/users/${encodeURIComponent(normalized)}`;
    const { response, text } = await fetchText(url, platform);
    if (response.url.includes("/404") || /404 Not Found|User not found/i.test(text)) throw Object.assign(new Error("没有找到这个 AtCoder 用户"), { status: 404, code: "not_found" });
    const affiliation = text.match(/<th[^>]*>\s*Affiliation\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "";
    const avatar = text.match(/<img[^>]+class="avatar"[^>]+src="([^"]+)"/i)?.[1] || "";
    return { platform, handle: normalized, normalizedHandle: normalized, externalUserId: normalized, avatarUrl: clean(avatar.startsWith("//") ? `https:${avatar}` : avatar, 1000), profileUrl: url, verificationText: htmlText(affiliation) };
  }
  throw Object.assign(new Error("不支持的平台"), { status: 400, code: "unsupported_platform" });
}

export async function hmacCode(value: string) {
  const secret = Deno.env.get("TRAINING_BINDING_SECRET") || `${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""}:training-binding-v1`;
  if (secret.length < 32) throw new Error("Training binding secret is not configured");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value.toUpperCase()));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function newVerificationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `LEATHER-${[...bytes].map(byte => alphabet[byte % alphabet.length]).join("")}`;
}

export async function profileContainsChallenge(profile: ExternalProfile, expectedHash: string) {
  const candidates = profile.verificationText.toUpperCase().match(/LEATHER-[A-Z2-9]{6}/g) || [];
  for (const candidate of new Set(candidates)) if (await hmacCode(candidate) === expectedHash) return true;
  return false;
}

export function fallbackChallenge(platform: Platform) {
  if (platform === "codeforces") return { problemId: "4A", title: "Watermelon", url: "https://codeforces.com/problemset/problem/4/A", verdict: "COMPILATION_ERROR", windowMinutes: 20 };
  return { problemId: "abc086_a", title: "Product", url: "https://atcoder.jp/contests/abc086/tasks/abc086_a", verdict: "CE", windowMinutes: 120 };
}

export async function verifySubmissionChallenge(profile: ExternalProfile, payload: Record<string, unknown>, createdAt: string) {
  const page = await syncPage({ platform: profile.platform, handle: profile.handle, external_user_id: profile.externalUserId }, profile.platform === "atcoder" ? { fromSecond: Math.floor(Date.parse(createdAt) / 1000) - 30, mode: "verify" } : { page: 1, from: 1, mode: "verify" });
  const after = Date.parse(createdAt) - 30000;
  return page.submissions.some(item => item.problemExternalId === payload.problemId && item.verdict.toUpperCase().includes(String(payload.verdict || "").toUpperCase()) && Date.parse(item.submittedAt) >= after);
}

type AccountInput = { platform: Platform; handle: string; external_user_id: string };

export async function syncPage(account: AccountInput, cursor: Record<string, unknown> = {}): Promise<SyncPage> {
  if (account.platform === "codeforces") return syncCodeforces(account, cursor);
  return syncAtcoder(account, cursor);
}

async function syncCodeforces(account: AccountInput, cursor: Record<string, unknown>): Promise<SyncPage> {
  const count = 500;
  const from = cursor.mode === "incremental" ? 1 : Math.max(1, Number(cursor.from || 1));
  const payload = await fetchJson<{ status: string; comment?: string; result?: Array<Record<string, unknown>> }>(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(account.handle)}&from=${from}&count=${count}`, "codeforces", 20000);
  if (payload.status !== "OK") throw Object.assign(new Error(clean(payload.comment || "Codeforces API failed")), { code: "source_error", retryable: true });
  const rows = payload.result || [];
  const problems = new Map<string, NormalizedProblem>();
  const submissions: NormalizedSubmission[] = [];
  for (const row of rows) {
    const problem = (row.problem || {}) as Record<string, unknown>;
    const contestId = clean(problem.contestId, 30);
    const index = clean(problem.index, 20);
    if (!contestId || !index) continue;
    const id = `${contestId}${index}`;
    const raw = Number.isFinite(Number(problem.rating)) ? Number(problem.rating) : null;
    const difficulty = mapDifficulty("codeforces", raw);
    problems.set(id, { platform: "codeforces", externalProblemId: id, contestId, index, title: clean(problem.name, 240) || id, url: `https://codeforces.com/problemset/problem/${encodeURIComponent(contestId)}/${encodeURIComponent(index)}`, rawDifficulty: raw, normalizedDifficulty: difficulty.normalized, mapCode: difficulty.mapCode, rawTags: Array.isArray(problem.tags) ? problem.tags.map(tag => clean(tag, 80)).filter(Boolean) : [] });
    const verdict = clean(row.verdict || "UNKNOWN", 80);
    submissions.push({ externalSubmissionId: clean(row.id, 80), problemExternalId: id, verdict, accepted: verdict === "OK", language: clean(row.programmingLanguage, 80), submittedAt: new Date(Number(row.creationTimeSeconds) * 1000).toISOString(), timeMs: Number.isFinite(Number(row.timeConsumedMillis)) ? Number(row.timeConsumedMillis) : null, memoryKb: Number.isFinite(Number(row.memoryConsumedBytes)) ? Math.round(Number(row.memoryConsumedBytes) / 1024) : null });
  }
  const more = cursor.mode !== "incremental" && rows.length === count;
  return { problems: [...problems.values()], submissions, cursor: more ? { from: from + count, mode: "initial" } : { from: 1, mode: "incremental" }, more, dataThrough: submissions[0]?.submittedAt || null };
}

async function syncAtcoder(account: AccountInput, cursor: Record<string, unknown>): Promise<SyncPage> {
  const fromSecond = Math.max(0, Number(cursor.fromSecond || 0));
  const rows = await fetchJson<Array<Record<string, unknown>>>(`https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions?user=${encodeURIComponent(account.handle)}&from_second=${fromSecond}`, "atcoder", 25000);
  const problems = new Map<string, NormalizedProblem>();
  const submissions: NormalizedSubmission[] = [];
  let maxSecond = fromSecond;
  for (const row of rows) {
    const problemId = clean(row.problem_id, 100);
    if (!problemId) continue;
    const contestId = clean(row.contest_id, 100);
    const epoch = Number(row.epoch_second || 0);maxSecond = Math.max(maxSecond, epoch);
    problems.set(problemId, { platform: "atcoder", externalProblemId: problemId, contestId, index: problemId.split("_").pop() || "", title: problemId, url: `https://atcoder.jp/contests/${encodeURIComponent(contestId)}/tasks/${encodeURIComponent(problemId)}`, rawDifficulty: null, normalizedDifficulty: null, mapCode: null, rawTags: [], metadata: { point: row.point } });
    const verdict = clean(row.result || "UNKNOWN", 80);
    submissions.push({ externalSubmissionId: clean(row.id, 80), problemExternalId: problemId, verdict, accepted: verdict === "AC", language: clean(row.language, 80), submittedAt: new Date(epoch * 1000).toISOString(), timeMs: Number.isFinite(Number(row.execution_time)) ? Number(row.execution_time) : null, memoryKb: Number.isFinite(Number(row.memory)) ? Number(row.memory) : null });
  }
  const more = rows.length >= 500;
  return { problems: [...problems.values()], submissions, cursor: { fromSecond: more ? maxSecond + 1 : maxSecond, mode: "incremental" }, more, dataThrough: submissions.length ? submissions[submissions.length - 1].submittedAt : null };
}
