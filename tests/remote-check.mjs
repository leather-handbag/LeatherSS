import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF;
assert(url && key && serviceKey && accessToken && projectRef, "Remote test environment is incomplete");

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(url, serviceKey, options);
const visitor = createClient(url, key, options);
const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const users = [];
const avatarPaths = [];
const checks = [];

function ok(name) { checks.push(name); }
function noError(result, label) { assert.ifError(result.error, label); return result.data; }
async function expectError(request, label) { const result = await request; assert(result.error, `${label}: expected an error`); ok(label); }

async function databaseQuery(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ query })
  });
  if (!response.ok) throw new Error(`Management database query failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function createUser(kind) {
  const email = `codex-${stamp}-${kind}@example.com`;
  const password = `T!${crypto.randomUUID()}a8`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `Codex ${kind}` } });
  const user = noError(created, `create ${kind}`).user;
  users.push(user.id);
  const client = createClient(url, key, options);
  const generated = noError(await service.auth.admin.generateLink({ type: "magiclink", email }), `generate test link ${kind}`);
  noError(await client.auth.verifyOtp({ token_hash: generated.properties.hashed_token, type: "magiclink" }), `sign in ${kind}`);
  return { id: user.id, client };
}

async function setRole(id, role) {
  assert(/^[0-9a-f-]{36}$/i.test(id));
  assert(["user", "admin", "owner"].includes(role));
  await databaseQuery(`begin; set local app.privileged_profile_write='true'; update public.profiles set role='${role}', updated_at=now() where id='${id}'::uuid; commit;`);
}

try {
  const owner = await createUser("owner");
  const admin = await createUser("admin");
  const one = await createUser("user-one");
  const two = await createUser("user-two");
  await setRole(owner.id, "owner");
  await setRole(admin.id, "admin");

  const self = noError(await one.client.rpc("get_my_profile").single(), "get own profile");
  assert.equal(self.role, "user");
  const oneHandle = `test_${stamp.replaceAll("-", "").slice(-18)}`;
  noError(await one.client.rpc("update_my_profile", { p_display_name: "远端测试用户", p_handle: oneHandle, p_bio: "自动清理的权限回归账号" }), "update own profile");
  await expectError(one.client.from("profiles").select("*"), "sensitive profile table is not directly readable");

  const privatePost = noError(await one.client.from("posts").insert({ user_id: one.id, title: "私有回归文章", content: "private regression content", visibility: "private" }).select().single(), "create private post");
  const publicPost = noError(await one.client.from("posts").insert({ user_id: one.id, title: "公开回归文章", content: "public regression content", visibility: "public" }).select().single(), "create public post");
  const visitorPosts = noError(await visitor.from("posts").select("id").in("id", [privatePost.id, publicPost.id]), "visitor reads posts");
  assert.deepEqual(visitorPosts.map(v => v.id), [publicPost.id]);
  const otherPosts = noError(await two.client.from("posts").select("id").in("id", [privatePost.id, publicPost.id]), "other user reads posts");
  assert.deepEqual(otherPosts.map(v => v.id), [publicPost.id]);
  const staffPosts = noError(await admin.client.from("posts").select("id").in("id", [privatePost.id, publicPost.id]), "admin reads posts");
  assert.equal(staffPosts.length, 2); ok("public/private post RLS");

  noError(await two.client.from("post_comments").insert({ post_id: publicPost.id, user_id: two.id, content: "公开文章评论回归" }), "comment on public post");
  await expectError(two.client.from("post_comments").insert({ post_id: privatePost.id, user_id: two.id, content: "不应写入的私有评论" }), "private post rejects comments");
  const parentDiscussion = noError(await one.client.from("station_comments").insert({ user_id: one.id, kind: "academic", content: "讨论区父级内容" }).select().single(), "create discussion");
  const replyDiscussion = noError(await two.client.from("station_comments").insert({ user_id: two.id, kind: "academic", content: `@${oneHandle} 讨论区回复通知`, reply_to: parentDiscussion.id }).select().single(), "reply and mention");
  let mentions = noError(await one.client.rpc("get_mention_notifications", { limit_count: 30 }), "read own mention notifications");
  assert(mentions.some(v => v.discussion_id === replyDiscussion.id && v.actor_id === two.id && !v.is_read));
  noError(await one.client.rpc("mark_mention_notifications_read"), "mark mention notifications read");
  mentions = noError(await one.client.rpc("get_mention_notifications", { limit_count: 30 }), "refresh mention notifications");
  assert(mentions.some(v => v.discussion_id === replyDiscussion.id && v.is_read));
  noError(await two.client.from("station_comments").delete().eq("id", replyDiscussion.id), "author deletes discussion");
  const removedDiscussion = noError(await visitor.from("station_comments").select("id").eq("id", replyDiscussion.id), "verify discussion deletion");
  assert.equal(removedDiscussion.length, 0); ok("discussion reply, mention and author deletion");

  const initialAutosave = noError(await one.client.rpc("get_blog_autosave_minutes"), "read blog autosave setting");
  assert([5, 10, 30].includes(Number(initialAutosave)));
  noError(await one.client.rpc("set_blog_autosave_minutes", { p_minutes: 5 }), "set blog autosave interval");
  assert.equal(Number(noError(await one.client.rpc("get_blog_autosave_minutes"), "verify blog autosave interval")), 5);
  noError(await one.client.rpc("set_blog_autosave_minutes", { p_minutes: 10 }), "restore blog autosave interval"); ok("synced blog autosave setting");

  const firstCheckin = noError(await one.client.rpc("daily_checkin"), "first daily check-in");
  const secondCheckin = noError(await one.client.rpc("daily_checkin"), "second daily check-in");
  assert.equal(firstCheckin.number, secondCheckin.number); assert.equal(firstCheckin.draw_count, 3); ok("three-draw idempotent daily check-in");

  const moderationCount = await databaseQuery("select count(*)::integer as count, count(distinct category)::integer as categories from private.sensitive_terms;");
  assert(moderationCount[0].count >= 400 && moderationCount[0].categories >= 8); ok("expanded strict moderation dictionary");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
  const avatarPath = `${one.id}/${crypto.randomUUID()}.png`; avatarPaths.push(avatarPath);
  noError(await one.client.storage.from("avatars").upload(avatarPath, png, { contentType: "image/png" }), "upload avatar candidate");
  const avatarUrl = one.client.storage.from("avatars").getPublicUrl(avatarPath).data.publicUrl;
  const request = noError(await one.client.rpc("submit_avatar_request", { p_object_path: avatarPath, p_avatar_url: avatarUrl }), "submit avatar request");
  const requestId = Array.isArray(request) ? request[0].id : request.id;
  const pending = noError(await admin.client.from("avatar_requests").select("id").eq("id", requestId).single(), "admin reads pending avatar");
  assert.equal(pending.id, requestId);
  noError(await admin.client.rpc("review_avatar_request", { request_id: requestId, is_approved: true, note: "" }), "admin approves avatar");
  const publicProfile = noError(await visitor.from("public_profile_stats").select("avatar_url").eq("id", one.id).single(), "public profile after avatar approval");
  assert.equal(publicProfile.avatar_url, avatarUrl); ok("avatar approval workflow");

  await expectError(admin.client.rpc("owner_list_banned_users", { limit_count: 100 }), "admin cannot read owner ban list");
  await expectError(admin.client.rpc("admin_ban_user", { target_id: owner.id, reason: "越权测试" }), "admin cannot ban owner");
  noError(await admin.client.rpc("admin_ban_user", { target_id: two.id, reason: "管理员权限回归测试" }), "admin bans ordinary user");
  await expectError(two.client.rpc("update_my_profile", { p_display_name: "blocked", p_handle: `blocked_${stamp.slice(-8)}`, p_bio: "" }), "banned user cannot write");
  await expectError(admin.client.rpc("owner_unban_user", { target_id: two.id }), "admin cannot unban");
  let banned = noError(await owner.client.rpc("owner_list_banned_users", { limit_count: 100 }), "owner lists bans");
  assert(banned.some(v => v.id === two.id && v.ban_reason === "管理员权限回归测试"));
  noError(await owner.client.rpc("owner_unban_user", { target_id: two.id }), "owner unbans user"); ok("owner-only ban list and unban");

  noError(await two.client.from("posts").insert({ user_id: two.id, title: "敏感词审核回归", content: "nmsl", visibility: "public" }), "submit moderated post");
  const moderated = noError(await two.client.rpc("get_my_profile").single(), "read moderation state");
  assert(moderated.banned_at && /敏感内容/.test(moderated.ban_reason));
  const deleted = noError(await admin.client.from("posts").select("id").eq("user_id", two.id).eq("title", "敏感词审核回归"), "check hard deletion");
  assert.equal(deleted.length, 0);
  banned = noError(await owner.client.rpc("owner_list_banned_users", { limit_count: 100 }), "owner reads automatic ban");
  assert(banned.some(v => v.id === two.id));
  noError(await owner.client.rpc("owner_unban_user", { target_id: two.id }), "owner clears automatic ban"); ok("automatic deletion and ban");

  noError(await owner.client.rpc("owner_set_admin", { target_id: two.id, enabled: true }), "owner promotes admin");
  let directory = noError(await admin.client.rpc("admin_list_users", { search_query: "" }), "admin user directory");
  assert(directory.some(v => v.id === two.id && v.role === "admin"));
  noError(await owner.client.rpc("owner_set_admin", { target_id: two.id, enabled: false }), "owner demotes admin");
  directory = noError(await admin.client.rpc("admin_list_users", { search_query: "" }), "refresh admin directory");
  assert(directory.some(v => v.id === two.id && v.role === "user")); ok("owner role management");

  const events = noError(await admin.client.rpc("get_moderation_events", { limit_count: 100 }), "staff reads audit events");
  assert(events.some(v => v.source_table === "avatar_requests") && events.some(v => v.user_id === two.id)); ok("moderation audit trail");

  console.log(JSON.stringify({ passed: true, checks, temporaryUsers: users.length }));
} finally {
  if (avatarPaths.length) await service.storage.from("avatars").remove(avatarPaths);
  if (users.length) {
    const ids = users.filter(v => /^[0-9a-f-]{36}$/i.test(v)).map(v => `'${v}'::uuid`).join(",");
    if (ids) await databaseQuery(`delete from private.moderation_events where user_id in (${ids}) or actor_id in (${ids});`).catch(() => {});
  }
  for (const id of users.reverse()) await service.auth.admin.deleteUser(id).catch(() => {});
}
