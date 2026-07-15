import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF;
assert(url && key && serviceKey && accessToken && projectRef, "Remote test environment is incomplete");

const timedFetch = (input, init = {}) => fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: timedFetch } };
const service = createClient(url, serviceKey, options);
const visitor = createClient(url, key, options);
const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const users = [];
const avatarPaths = [];
const checks = [];

function ok(name) { checks.push(name); }
function stage(name) { console.log(JSON.stringify({ stage: name })); }
function noError(result, label) { assert.ifError(result.error, label); return result.data; }
async function expectError(request, label) { const result = await request; assert(result.error, `${label}: expected an error`); ok(label); }

async function databaseQuery(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`Management database query failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function createUser(kind) {
  const email = `codex-${crypto.randomUUID()}-${kind}@example.com`;
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
  stage("temporary-users-created");
  await setRole(owner.id, "owner");
  await setRole(admin.id, "admin");
  stage("temporary-roles-ready");

  const self = noError(await one.client.rpc("get_my_profile").single(), "get own profile");
  assert.equal(self.role, "user");
  assert.notEqual(self.display_name, "Codex user-one");
  assert.match(self.display_name, /^codex-/i); ok("email-prefix profile initialization ignores OAuth full_name");
  const oneHandle = `test_${crypto.randomUUID().replaceAll("-", "").replace(/\d/g, "a").slice(0, 18)}`;
  const profileUpdate = noError(await one.client.rpc("update_my_profile", { p_display_name: "远端测试用户", p_handle: oneHandle, p_bio: "自动清理的权限回归账号" }), "update own profile");
  assert.equal(profileUpdate.ok, true); assert.equal(profileUpdate.banned, false);
  await expectError(one.client.from("profiles").select("*"), "sensitive profile table is not directly readable");

  const trainingDashboard = noError(await one.client.rpc("get_my_training_dashboard"), "read own training dashboard");
  assert.equal(trainingDashboard.maps.length, 7); assert(trainingDashboard.maps[0].unlocked); assert.equal(trainingDashboard.accounts.length, 0);
  assert(trainingDashboard.ability_estimate && typeof trainingDashboard.ability_estimate === "object");
  const luoguSync = noError(await one.client.rpc("enqueue_training_sync", { platform_name: "luogu" }), "Luogu sync request is safely rejected");
  assert.equal(luoguSync.error, "platform_unavailable");
  const publicTraining = noError(await visitor.rpc("get_training_profile", { target_user: one.id }), "read public training profile");
  assert.equal(publicTraining.visibility.map, true); assert.equal(publicTraining.maps.length, 7);
  noError(await one.client.rpc("update_training_privacy", { accounts_visible: false, heatmap_visible: false, map_visible: false, recent_visible: false }), "make training profile private");
  const lockedMap = noError(await two.client.rpc("get_training_map", { target_user: one.id }), "other user receives locked map DTO");
  assert.equal(lockedMap.locked, true); assert.equal(lockedMap.maps, null);
  await expectError(two.client.rpc("get_training_heatmap", { target_user: one.id, from_date: null, to_date: null, platform_name: null }), "ordinary user cannot read private heatmap");
  noError(await admin.client.rpc("get_training_heatmap", { target_user: one.id, from_date: null, to_date: null, platform_name: null }), "admin reads private heatmap through audited RPC");
  const trainingAudit = noError(await one.client.rpc("get_training_access_audit", { target_user: one.id, limit_count: 20 }), "owner of data reads private heatmap audit");
  assert(trainingAudit.some(v => v.actor_id === admin.id && v.resource === "private_heatmap"));
  await expectError(one.client.from("submission_events").select("*"), "raw training submissions are service-only");
  noError(await one.client.rpc("update_training_privacy", { accounts_visible: true, heatmap_visible: true, map_visible: true, recent_visible: true }), "restore public training profile");
  ok("training map defaults, privacy, staff audit and raw-event isolation");
  stage("training-privacy-passed");

  const frameCatalog = noError(await one.client.rpc("get_my_avatar_frames"), "read own avatar frame cabinet");
  assert(frameCatalog.length >= 7 && frameCatalog.every(v => !v.unlocked));
  await expectError(one.client.rpc("equip_avatar_frame", { frame_code: "map_conqueror" }), "locked avatar frame cannot be equipped");
  await databaseQuery(`insert into public.user_achievements(user_id,code,detail) values('${one.id}'::uuid,'streak_30','remote test') on conflict do nothing;`);
  const unlockedFrames = noError(await one.client.rpc("get_my_avatar_frames"), "achievement unlocks avatar frame");
  assert(unlockedFrames.some(v => v.code === "laurel_streak" && v.unlocked));
  noError(await one.client.rpc("equip_avatar_frame", { frame_code: "laurel_streak" }), "equip unlocked avatar frame");
  const framedProfile = noError(await visitor.from("public_profile_stats").select("avatar_frame").eq("id", one.id).single(), "public frame DTO");
  assert.equal(framedProfile.avatar_frame.code, "laurel_streak");
  noError(await one.client.rpc("equip_avatar_frame", { frame_code: null }), "unequip avatar frame"); ok("avatar frame entitlement and public DTO");

  const reportList = noError(await one.client.rpc("get_my_learning_reports", { limit_count: 12 }), "read own monthly reports");
  assert(Array.isArray(reportList));
  const hiddenReports = noError(await two.client.from("monthly_learning_reports").select("id").eq("user_id", one.id), "other user receives no private monthly reports");
  assert.equal(hiddenReports.length, 0); ok("other user cannot read private monthly reports");
  await expectError(one.client.rpc("generate_due_learning_reports"), "ordinary user cannot generate monthly reports");

  const privatePost = noError(await one.client.from("posts").insert({ user_id: one.id, title: "私有回归文章", content: "private regression content", visibility: "private" }).select().single(), "create private post");
  const publicPost = noError(await one.client.from("posts").insert({ user_id: one.id, title: "公开回归文章", content: "public regression content", visibility: "public" }).select().single(), "create public post");
  const visitorPosts = noError(await visitor.from("posts").select("id").in("id", [privatePost.id, publicPost.id]), "visitor reads posts");
  assert.deepEqual(visitorPosts.map(v => v.id), [publicPost.id]);
  const otherPosts = noError(await two.client.from("posts").select("id").in("id", [privatePost.id, publicPost.id]), "other user reads posts");
  assert.deepEqual(otherPosts.map(v => v.id), [publicPost.id]);
  const staffPosts = noError(await admin.client.from("posts").select("id").in("id", [privatePost.id, publicPost.id]), "admin reads posts");
  assert.equal(staffPosts.length, 2); ok("public/private post RLS");
  stage("post-rls-passed");

  const publicComment = noError(await two.client.from("post_comments").insert({ post_id: publicPost.id, user_id: two.id, content: "公开文章评论回归" }).select().single(), "comment on public post");
  await expectError(two.client.from("post_comments").insert({ post_id: privatePost.id, user_id: two.id, content: "不应写入的私有评论" }), "private post rejects comments");
  const parentDiscussion = noError(await one.client.from("station_comments").insert({ user_id: one.id, kind: "academic", content: "讨论区父级内容" }).select().single(), "create discussion");
  const replyDiscussion = noError(await two.client.from("station_comments").insert({ user_id: two.id, kind: "academic", content: `@${oneHandle} 讨论区回复通知`, reply_to: parentDiscussion.id }).select().single(), "reply and mention");
  let notifications = noError(await one.client.rpc("get_notifications", { limit_count: 100 }), "read discussion reply notification");
  assert(notifications.some(v => v.type === "discussion_reply" && v.source_id === replyDiscussion.id && v.actor_id === two.id && !v.is_read));
  noError(await one.client.rpc("mark_notifications_read"), "mark discussion notification read");
  noError(await two.client.from("station_comments").delete().eq("id", replyDiscussion.id), "author deletes discussion");
  const removedDiscussion = noError(await visitor.from("station_comments").select("id").eq("id", replyDiscussion.id), "verify discussion deletion");
  assert.equal(removedDiscussion.length, 0); ok("discussion reply, mention and author deletion");
  stage("discussion-notifications-passed");

  const initialAutosave = noError(await one.client.rpc("get_blog_autosave_minutes"), "read blog autosave setting");
  assert([0, 30].includes(Number(initialAutosave)));
  noError(await one.client.rpc("set_blog_autosave_minutes", { p_minutes: 0 }), "disable blog autosave");
  assert.equal(Number(noError(await one.client.rpc("get_blog_autosave_minutes"), "verify disabled blog autosave")), 0);
  noError(await one.client.rpc("set_blog_autosave_minutes", { p_minutes: 30 }), "enable 30-minute blog autosave"); ok("synced blog autosave toggle");

  let snapshots = noError(await one.client.from("post_snapshots").select("id,title,content").eq("post_id", publicPost.id).order("created_at", { ascending: false }), "read initial blog snapshots");
  assert(snapshots.length >= 1);
  noError(await one.client.from("posts").update({ content: "updated snapshot regression", updated_at: new Date().toISOString() }).eq("id", publicPost.id).eq("user_id", one.id), "update post for snapshot");
  snapshots = noError(await one.client.from("post_snapshots").select("id,title,content").eq("post_id", publicPost.id).order("created_at", { ascending: false }), "read updated blog snapshots");
  assert(snapshots.length >= 2);
  noError(await one.client.rpc("restore_post_snapshot", { snapshot_id: snapshots.at(-1).id }), "restore blog snapshot"); ok("blog snapshot history and restore");

  noError(await two.client.from("post_likes").insert({ post_id: publicPost.id, user_id: two.id }), "like public post");
  let engagement = noError(await visitor.from("post_engagement").select("like_count,favorite_count").eq("post_id", publicPost.id).single(), "read public post engagement");
  assert.equal(engagement.like_count, 1);
  const folders = noError(await two.client.from("favorite_folders").select("id,is_default").eq("user_id", two.id), "read favorite folders");
  assert(folders.some(v => v.is_default));
  noError(await two.client.rpc("favorite_post", { target_post: publicPost.id, target_folder: null }), "favorite public post");
  engagement = noError(await visitor.from("post_engagement").select("like_count,favorite_count").eq("post_id", publicPost.id).single(), "refresh public post engagement");
  assert.equal(engagement.favorite_count, 1); ok("post likes and favorite folders");

  noError(await two.client.from("user_follows").insert({ follower_id: two.id, following_id: one.id }), "follow another user");
  notifications = noError(await one.client.rpc("get_notifications", { limit_count: 100 }), "read unified notifications");
  assert(notifications.some(v => v.type === "post_comment" && v.source_id === publicComment.id));
  assert(notifications.some(v => v.type === "follow" && v.actor_id === two.id));
  noError(await one.client.rpc("mark_notifications_read"), "mark unified notifications read");
  notifications = noError(await one.client.rpc("get_notifications", { limit_count: 100 }), "refresh unified notifications");
  assert(notifications.every(v => v.is_read));
  const profileSocial = noError(await visitor.from("public_profile_stats").select("follower_count,following_count").eq("id", one.id).single(), "read public social counts");
  assert.equal(profileSocial.follower_count, 1); ok("follow graph and categorized notifications");

  const achievements = noError(await visitor.rpc("get_user_achievements", { target_user: one.id }), "read public achievements");
  assert(achievements.some(v => v.code === "posts_1") && achievements.some(v => v.code === "discussions_1")); ok("achievement badges");

  const firstCheckin = noError(await one.client.rpc("daily_checkin"), "first daily check-in");
  const secondCheckin = noError(await one.client.rpc("daily_checkin"), "second daily check-in");
  assert.equal(firstCheckin.number, secondCheckin.number); assert.equal(firstCheckin.draw_count, 10); ok("ten-draw idempotent daily check-in");

  const weekLuck = noError(await visitor.rpc("get_luck_leaderboard", { period_name: "week" }), "read weekly luck leaderboard");
  const historyLuck = noError(await visitor.rpc("get_luck_leaderboard", { period_name: "history" }), "read historical luck leaderboard");
  assert(weekLuck.some(v => v.user_id === one.id && v.number === firstCheckin.number));
  assert(historyLuck.some(v => v.user_id === one.id && v.number === firstCheckin.number));
  const chromatic = await databaseQuery("select * from private.rate_checkin(111101);");
  assert.equal(chromatic[0].rarity, "chromatic"); ok("weekly/history luck ranking and chromatic rarity");

  const moderationCount = await databaseQuery("select count(*)::integer as count, count(distinct category)::integer as categories from private.sensitive_terms;");
  assert(moderationCount[0].count >= 400 && moderationCount[0].categories >= 8); ok("expanded strict moderation dictionary");
  stage("checkin-and-moderation-passed");

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
  assert.equal(publicProfile.avatar_url, avatarUrl);
  notifications = noError(await one.client.rpc("get_notifications", { limit_count: 100 }), "read avatar system notification");
  assert(notifications.some(v => v.type === "system" && v.source_id === requestId)); ok("avatar approval workflow and system notification");

  await expectError(admin.client.rpc("owner_list_banned_users", { limit_count: 100 }), "admin cannot read owner ban list");
  await expectError(admin.client.rpc("admin_ban_user", { target_id: owner.id, reason: "越权测试" }), "admin cannot ban owner");
  noError(await admin.client.rpc("admin_ban_user", { target_id: two.id, reason: "管理员权限回归测试" }), "admin bans ordinary user");
  const bannedWrite = noError(await two.client.rpc("update_my_profile", { p_display_name: "blocked", p_handle: `blocked_${stamp.slice(-8)}`, p_bio: "" }), "banned user receives structured profile response");
  assert.equal(bannedWrite.banned, true);
  await expectError(admin.client.rpc("owner_unban_user", { target_id: two.id }), "admin cannot unban");
  let banned = noError(await owner.client.rpc("owner_list_banned_users", { limit_count: 100 }), "owner lists bans");
  assert(banned.some(v => v.id === two.id && v.ban_reason === "管理员权限回归测试"));
  noError(await owner.client.rpc("owner_unban_user", { target_id: two.id }), "owner unbans user"); ok("owner-only ban list and unban");

  const unsafeName = noError(await two.client.rpc("update_my_profile", { p_display_name: "nmsl", p_handle: `safe_${stamp.slice(-8)}`, p_bio: "should not persist" }), "unsafe name returns atomic ban response");
  assert.equal(unsafeName.ok, false); assert.equal(unsafeName.banned, true); assert.equal(unsafeName.profile.display_name, "已封禁用户"); assert.equal(unsafeName.profile.bio, "");
  noError(await owner.client.rpc("owner_unban_user", { target_id: two.id }), "owner clears unsafe-name ban"); ok("unsafe display name bans atomically without partial profile writes");

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
  stage("cleanup-started");
  if (avatarPaths.length) await service.storage.from("avatars").remove(avatarPaths);
  if (users.length) {
    const ids = users.filter(v => /^[0-9a-f-]{36}$/i.test(v)).map(v => `'${v}'::uuid`).join(",");
    if (ids) await databaseQuery(`delete from private.moderation_events where user_id in (${ids}) or actor_id in (${ids});`).catch(() => {});
  }
  for (const id of users.reverse()) await service.auth.admin.deleteUser(id).catch(() => {});
  stage("cleanup-finished");
}
