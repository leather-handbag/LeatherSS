import { supabase, supabaseConfigured, supabaseErrorText, turnstileConfigured, turnstileSiteKey } from "./supabase.js";

export { turnstileConfigured, turnstileSiteKey };

export const cloud = { configured: supabaseConfigured, user: null, profile: null, stats: null, avatarRequest: null, session: null, authReady: false };

function fail(error) { if (error) throw new Error(supabaseErrorText(error)); }
function redirectUrl() { return `${location.origin}${location.pathname}`; }
function searchTerm(value) { return String(value || "").normalize("NFKC").replace(/[^\p{L}\p{N}@_-]/gu, "").slice(0, 30); }

export async function refreshProfile() {
  if (!supabase || !cloud.user) { cloud.profile = null; cloud.stats = null; cloud.avatarRequest = null; return null; }
  const [{ data: profile, error }, { data: stats, error: statsError }, { data: avatarRequest, error: avatarError }] = await Promise.all([
    supabase.rpc("get_my_profile").maybeSingle(),
    supabase.from("public_profile_stats").select("*").eq("id", cloud.user.id).maybeSingle(),
    supabase.from("avatar_requests").select("id,status,review_note,created_at,reviewed_at").eq("user_id", cloud.user.id).order("created_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  fail(error); fail(statsError); fail(avatarError); cloud.profile = profile || null; cloud.stats = stats || null; cloud.avatarRequest = avatarRequest || null; return cloud.profile;
}

export async function initCloud(onChange) {
  if (!supabase) { cloud.authReady = true; await onChange?.("UNCONFIGURED", null); return; }
  const { data, error } = await supabase.auth.getSession(); fail(error);
  cloud.session = data.session; cloud.user = data.session?.user || null;
  if (cloud.user) await refreshProfile();
  cloud.authReady = true; await onChange?.("INITIAL_SESSION", cloud.session);
  supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      cloud.session = session; cloud.user = session?.user || null;
      try { await refreshProfile(); } catch {}
      await onChange?.(event, session);
    }, 0);
  });
}

export async function emailLogin(email, password, captchaToken) {
  const { error } = await supabase.auth.signInWithPassword({ email, password, options: { captchaToken } }); fail(error);
}
export async function emailSignup(email, password, captchaToken) {
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectUrl(), captchaToken } }); fail(error); return data;
}
export async function githubLogin() {
  const { error } = await supabase.auth.signInWithOAuth({ provider: "github", options: { redirectTo: redirectUrl(), scopes: "read:user user:email" } }); fail(error);
}
export async function sendPasswordReset(email, captchaToken) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${redirectUrl()}#account`, captchaToken }); fail(error);
}
export async function updatePassword(password) { const { error } = await supabase.auth.updateUser({ password }); fail(error); }
export async function signOut() { const { error } = await supabase.auth.signOut(); fail(error); }

export async function updateProfile(value) {
  const { error } = await supabase.rpc("update_my_profile", { p_display_name: value.displayName, p_handle: value.handle.toLowerCase(), p_bio: value.bio }); fail(error); await refreshProfile();
}
export async function uploadAvatar(file) {
  if (!file || file.size > 2 * 1024 * 1024) throw new Error("头像不能超过 2 MB");
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("头像格式只支持 PNG、JPEG、WebP 或 GIF");
  const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" })[file.type];
  const path = `${cloud.user.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type }); fail(error);
  const avatarUrl = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  const { data, error: requestError } = await supabase.rpc("submit_avatar_request", { p_object_path: path, p_avatar_url: avatarUrl });
  if (requestError) { await supabase.storage.from("avatars").remove([path]); fail(requestError); }
  cloud.avatarRequest = Array.isArray(data) ? data[0] : data;
  return cloud.avatarRequest;
}

async function profilesByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))]; if (!unique.length) return new Map();
  const requests = [];
  for (let i = 0; i < unique.length; i += 100) requests.push(supabase.from("public_profile_stats").select("*").in("id", unique.slice(i, i + 100)));
  const results = await Promise.all(requests), rows = [];
  for (const result of results) { fail(result.error); rows.push(...(result.data || [])); }
  return new Map(rows.map(item => [item.id, item]));
}
function profileName(profile) { return profile?.display_name || profile?.handle || "Leather 用户"; }

export async function fetchBlogData() {
  const [{ data: posts, error: postError }, { data: comments, error: commentError }, { data: station, error: stationError }] = await Promise.all([
    supabase.from("posts").select("*").order("updated_at", { ascending: false }).limit(500),
    supabase.from("post_comments").select("*").order("created_at", { ascending: true }).limit(5000),
    supabase.from("station_comments").select("*").order("created_at", { ascending: true }).limit(500)
  ]);
  fail(postError); fail(commentError); fail(stationError);
  const profiles = await profilesByIds([...(posts || []).map(v => v.user_id), ...(comments || []).map(v => v.user_id), ...(station || []).map(v => v.user_id)]);
  const grouped = new Map();
  for (const item of comments || []) { if (!grouped.has(item.post_id)) grouped.set(item.post_id, []); grouped.get(item.post_id).push(item); }
  const blogs = (posts || []).map(item => {
    const author = profiles.get(item.user_id);
    return { id: item.id, userId: item.user_id, title: item.title, author: profileName(author), authorHandle: author?.handle || "", authorRole: author?.role || "user", authorColor: author?.name_color || "blue", summary: item.summary, content: item.content, tags: item.tags || [], visibility: item.visibility, created: Date.parse(item.created_at), updated: Date.parse(item.updated_at), comments: (grouped.get(item.id) || []).map(comment => { const owner = profiles.get(comment.user_id); return { id: comment.id, userId: comment.user_id, author: profileName(owner), authorHandle: owner?.handle || "", authorRole: owner?.role || "user", authorColor: owner?.name_color || "blue", content: comment.content, time: Date.parse(comment.created_at) }; }) };
  });
  const stationComments = (station || []).map(comment => { const owner = profiles.get(comment.user_id); return { id: comment.id, userId: comment.user_id, author: profileName(owner), authorHandle: owner?.handle || "", authorRole: owner?.role || "user", authorColor: owner?.name_color || "blue", type: comment.kind, content: comment.content, time: Date.parse(comment.created_at) }; });
  return { blogs, station: stationComments };
}

export async function savePost(value, id = null) {
  const payload = { user_id: cloud.user.id, title: value.title, summary: value.summary, content: value.content, tags: value.tags, visibility: value.visibility, updated_at: new Date().toISOString() };
  let query;
  if (id) query = supabase.from("posts").update(payload).eq("id", id).eq("user_id", cloud.user.id).select().maybeSingle();
  else query = supabase.from("posts").insert(payload).select().maybeSingle();
  const { data, error } = await query; fail(error);
  if (!data) { await refreshProfile(); throw new Error(cloud.profile?.banned_at ? `账号已被自动封禁：${cloud.profile.ban_reason || "内容违规"}` : "内容未写入，可能触发了配额或审核规则"); }
  return data;
}
export async function deletePost(id) { const { error } = await supabase.from("posts").delete().eq("id", id); fail(error); }
export async function addPostComment(postId, content) { const { data, error } = await supabase.from("post_comments").insert({ post_id: postId, user_id: cloud.user.id, content }).select().maybeSingle(); fail(error); if (!data) throw new Error("评论被服务端审核拦截"); return data; }
export async function updatePostComment(id, content) { const { data, error } = await supabase.from("post_comments").update({ content, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", cloud.user.id).select().maybeSingle(); fail(error); if (!data) throw new Error("评论未更新，可能被服务端审核删除"); return data; }
export async function deletePostComment(id) { const { error } = await supabase.from("post_comments").delete().eq("id", id); fail(error); }
export async function addStationComment(kind, content) { const { data, error } = await supabase.from("station_comments").insert({ user_id: cloud.user.id, kind, content }).select().maybeSingle(); fail(error); if (!data) throw new Error("留言被服务端审核拦截"); return data; }
export async function updateStationComment(id, content) { const { data, error } = await supabase.from("station_comments").update({ content, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", cloud.user.id).select().maybeSingle(); fail(error); if (!data) throw new Error("留言未更新，可能被服务端审核删除"); return data; }
export async function deleteStationComment(id) { const { error } = await supabase.from("station_comments").delete().eq("id", id); fail(error); }

export async function fetchVault() {
  const [{ data: sections, error: se }, { data: templates, error: te }, { data: snapshots, error: ve }] = await Promise.all([
    supabase.from("template_sections").select("*").eq("user_id", cloud.user.id).order("position"),
    supabase.from("templates").select("*").eq("user_id", cloud.user.id).order("updated_at", { ascending: false }),
    supabase.from("template_snapshots").select("*").eq("user_id", cloud.user.id).order("created_at")
  ]); fail(se); fail(te); fail(ve);
  const versions = new Map(); for (const snap of snapshots || []) { if (!versions.has(snap.template_id)) versions.set(snap.template_id, []); versions.get(snap.template_id).push({ id: snap.id, time: Date.parse(snap.created_at), title: snap.title, lang: snap.lang, tags: snap.tags || [], code: snap.code }); }
  return { name: cloud.profile?.display_name || "我的模板库", sections: (sections || []).map(sec => ({ id: sec.id, name: sec.name, color: sec.color, position: sec.position, pages: (templates || []).filter(page => page.section_id === sec.id).map(page => ({ id: page.id, title: page.title, lang: page.lang, tags: page.tags || [], code: page.code, updated: Date.parse(page.updated_at), snapshots: versions.get(page.id) || [] })) })) };
}
export async function createSection(value) { const { data, error } = await supabase.from("template_sections").insert({ user_id: cloud.user.id, ...value }).select().single(); fail(error); return data; }
export async function updateSection(id, value) { const { data, error } = await supabase.from("template_sections").update(value).eq("id", id).eq("user_id", cloud.user.id).select().maybeSingle(); fail(error); if (!data) { await refreshProfile(); throw new Error(cloud.profile?.banned_at ? `账号已封禁：${cloud.profile.ban_reason || "分区名称违规"}` : "分区未更新"); } }
export async function deleteSection(id) { const { error } = await supabase.from("template_sections").delete().eq("id", id); fail(error); }
export async function createTemplate(value) { const { data, error } = await supabase.from("templates").insert({ user_id: cloud.user.id, ...value }).select().single(); fail(error); return data; }
export async function saveTemplate(id, value) {
  const { error } = await supabase.from("templates").update({ title: value.title, lang: value.lang, tags: value.tags, code: value.code, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", cloud.user.id); fail(error);
  const { data: snap, error: snapError } = await supabase.from("template_snapshots").insert({ template_id: id, user_id: cloud.user.id, title: value.title, lang: value.lang, tags: value.tags, code: value.code }).select().single(); fail(snapError); return snap;
}
export async function deleteTemplate(id) { const { error } = await supabase.from("templates").delete().eq("id", id); fail(error); }

export async function fetchPlan() { const { data, error } = await supabase.from("plans").select("*").eq("user_id", cloud.user.id).maybeSingle(); fail(error); return data; }
export async function savePlan(data) {
  const existing = await fetchPlan();
  const query = existing ? supabase.from("plans").update({ data, updated_at: new Date().toISOString() }).eq("id", existing.id).select().maybeSingle() : supabase.from("plans").insert({ user_id: cloud.user.id, data }).select().maybeSingle();
  const { data: saved, error } = await query; fail(error); if (!saved) { await refreshProfile(); throw new Error(cloud.profile?.banned_at ? `账号已封禁：${cloud.profile.ban_reason || "计划内容违规"}` : "计划未保存，可能超过账号配额"); }
}

export async function doDailyCheckin() { const { data, error } = await supabase.rpc("daily_checkin"); fail(error); return data; }
export async function enforceTextPolicy(input, source) { const { data, error } = await supabase.rpc("enforce_text_policy", { input_text: input, source_name: source }); fail(error); return data === true; }
export async function fetchCheckins() { const { data, error } = await supabase.from("daily_checkins").select("*").eq("user_id", cloud.user.id).order("checkin_date", { ascending: false }).limit(120); fail(error); return data || []; }
export async function fetchLeaderboard(search = "") {
  let query = supabase.from("public_profile_stats").select("*").order("score", { ascending: false }).order("checkin_count", { ascending: false }).limit(100);
  const term = searchTerm(search); if (term) query = query.or(`display_name.ilike.%${term}%,handle.ilike.%${term.replace(/^@/,"")}%`);
  const { data, error } = await query; fail(error); return data || [];
}
export async function fetchPublicProfile(idOrHandle) {
  let query = supabase.from("public_profile_stats").select("*");
  query = /^[0-9a-f-]{36}$/i.test(idOrHandle) ? query.eq("id", idOrHandle) : query.eq("handle", idOrHandle.replace(/^@/, "").toLowerCase());
  const { data, error } = await query.maybeSingle(); fail(error); return data;
}

export async function fetchAdminUsers(search = "") {
  const { data, error } = await supabase.rpc("admin_list_users", { search_query: searchTerm(search) }); fail(error); return data || [];
}
export async function fetchAvatarRequests() {
  const { data, error } = await supabase.from("avatar_requests").select("id,user_id,object_path,avatar_url,status,created_at").eq("status", "pending").order("created_at").limit(100); fail(error);
  const profiles = await profilesByIds((data || []).map(v => v.user_id));
  return (data || []).map(v => ({ ...v, profile: profiles.get(v.user_id) || null }));
}
export async function reviewAvatarRequest(id, approved, note = "") {
  const { data: path, error } = await supabase.rpc("review_avatar_request", { request_id: id, is_approved: approved, note }); fail(error);
  if (!approved && path) await supabase.storage.from("avatars").remove([path]);
}
export async function fetchBannedUsers() { const { data, error } = await supabase.rpc("owner_list_banned_users", { limit_count: 200 }); fail(error); return data || []; }
const adminTables = new Set(["posts","post_comments","station_comments","plans","templates"]);
export async function fetchAdminContent(table) { if (!adminTables.has(table)) throw new Error("不允许访问这个数据表"); const { data, error } = await supabase.from(table).select("*").order(table === "plans" ? "updated_at" : "created_at", { ascending: false }).limit(100); fail(error); return data || []; }
export async function deleteAdminContent(table, id) { if (!adminTables.has(table)) throw new Error("不允许删除这个数据表"); const { error } = await supabase.from(table).delete().eq("id", id); fail(error); }
export async function banUser(id, reason) { const { error } = await supabase.rpc("admin_ban_user", { target_id: id, reason }); fail(error); }
export async function unbanUser(id) { const { error } = await supabase.rpc("owner_unban_user", { target_id: id }); fail(error); }
export async function setAdmin(id, enabled) { const { error } = await supabase.rpc("owner_set_admin", { target_id: id, enabled }); fail(error); }
export async function fetchModerationEvents() { const { data, error } = await supabase.rpc("get_moderation_events", { limit_count: 100 }); fail(error); return data || []; }
