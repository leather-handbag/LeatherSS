import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const html = read("index.html"), app = read("app.js"), training = read("training-world.js"), cloud = read("cloud.js"), client = read("supabase.js");
const sql = read("supabase/migrations/202607130001_leather.sql") + "\n" + read("supabase/migrations/202607140002_discussions_lucky_draw.sql") + "\n" + read("supabase/migrations/202607150003_social_achievements_rankings.sql") + "\n" + read("supabase/migrations/202607150004_training_world_schema.sql") + "\n" + read("supabase/migrations/202607150005_training_world_logic.sql") + "\n" + read("supabase/migrations/202607150006_training_world_scheduler.sql") + "\n" + read("supabase/migrations/202607150007_training_catalog_schedule.sql") + "\n" + read("supabase/migrations/202607150008_training_privacy_hardening.sql") + "\n" + read("supabase/migrations/202607150009_training_worker_token.sql") + "\n" + read("supabase/migrations/202607160010_phase2_security_frames_luogu.sql") + "\n" + read("supabase/migrations/202607160011_phase2_regions_ability_unlocks.sql") + "\n" + read("supabase/migrations/202607160012_phase2_monthly_learning_reports.sql"), ignore = read(".gitignore"), workflow = read(".github/workflows/deploy.yml");
const pkg = JSON.parse(read("package.json"));

assert.equal(pkg.dependencies["@supabase/supabase-js"], "2.110.3", "Supabase SDK version missing");
assert.match(ignore, /^\.env$/m); assert.match(ignore, /^\.env\.\*$/m); assert.match(ignore, /^!\.env\.example$/m);
if (existsSync(new URL("../.env", import.meta.url))) {
  const env = read(".env");
  assert.match(env, /^VITE_SUPABASE_URL=https:\/\/.+\.supabase\.co$/m);
  assert.match(env, /^VITE_SUPABASE_ANON_KEY=\S+$/m);
  assert(!/service_role/i.test(env), "Local frontend env must never contain service_role");
}
assert(!/service_role/i.test(client + cloud + app + training), "Frontend source must never contain service_role");
assert.match(workflow, /VITE_SUPABASE_URL: \$\{\{ secrets\.VITE_SUPABASE_URL \}\}/);
assert.match(workflow, /VITE_SUPABASE_ANON_KEY: \$\{\{ secrets\.VITE_SUPABASE_ANON_KEY \}\}/);
assert.match(workflow, /VITE_TURNSTILE_SITE_KEY:[^\n]+vars\.VITE_TURNSTILE_SITE_KEY/);
assert.match(client, /VITE_TURNSTILE_SITE_KEY/); assert.match(cloud, /captchaToken/); assert.match(app, /turnstile\.render/);
assert(!/TURNSTILE_SECRET/i.test(client + cloud + app + html), "Turnstile Secret must never enter frontend source");

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(v => v[1]);
assert.equal(new Set(ids).size, ids.length, "Duplicate HTML id detected");
const dynamic = new Set(["articleCommentContent","articleCommentForm","articleCommentList","articleFavoriteFolder","articleFavoriteBtn","articleLikeBtn","articleReplyTarget","cancelArticleReply","cancelDiscussionReply","deleteSectionCheck","deleteTaskCheck","editSectionColor","editSectionName","levelColor","levelName","levelNote","newPageLang","newPageName","newSectionColor","newSectionName","printLearningReport","profileFollowBtn","restoreVersionBtn","taskDesc","taskDue","taskTitle","trainingBindHandle","turnstileScript"]);
const refs = [...(app + "\n" + training).matchAll(/\$\("#([A-Za-z][A-Za-z0-9_-]*)"/g)].map(v => v[1]);
const missing = [...new Set(refs.filter(id => !ids.includes(id) && !dynamic.has(id)))];
assert.deepEqual(missing, [], `Missing static DOM ids: ${missing.join(", ")}`);

const rlsTables = ["profiles","avatar_requests","posts","post_comments","station_comments","mention_notifications","post_snapshots","post_likes","favorite_folders","post_favorites","user_follows","notifications","achievement_definitions","user_achievements","template_sections","templates","template_snapshots","plans","daily_checkins","mastery_model_versions","training_maps","canonical_skills","map_regions","map_region_skills","external_accounts","binding_challenges","training_sync_jobs","training_sync_runs","problem_catalog","platform_tag_mappings","problem_skill_tags","problem_aliases","submission_events","user_problem_progress","training_daily_stats","skill_mastery","map_unlocks","training_privacy","training_recommendations","expedition_logs","training_feature_flags","training_catalog_state","avatar_frame_definitions","user_avatar_frames","user_ability_estimates","monthly_learning_reports","monthly_skill_snapshots"];
for (const table of rlsTables) {
  assert(sql.includes(`alter table public.${table} enable row level security;`), `RLS missing for ${table}`);
}
for (const feature of ["daily_checkin()","admin_ban_user","owner_unban_user","owner_set_admin","enforce_text_policy","moderate_written_content","public_profile_stats","submit_avatar_request","review_avatar_request","owner_list_banned_users","admin_list_users","get_my_profile","get_notifications","mark_notifications_read","set_blog_autosave_minutes","sync_discussion_mentions","restore_post_snapshot","favorite_post","user_follows","user_achievements","get_luck_leaderboard","chromatic","draw_count","get_my_training_dashboard","get_training_heatmap","update_training_privacy","claim_training_sync_job","refresh_training_mastery","training_access_audit","configure_training_worker_schedule","submission_events_client_deny","profile_name_violation","equip_avatar_frame","hard_problem_average","ability_average","monthly_learning_reports","generate_due_learning_reports"]) {
  assert(sql.includes(feature), `SQL feature missing: ${feature}`);
}
assert.match(sql, /handle\s*=\s*'leather-handbag'/); assert.match(sql, /target_id[\s\S]*role = 'owner'/);
assert.match(sql, /new\.avatar_url\s*:=\s*old\.avatar_url/);
assert.match(sql, /revoke all privileges on public\.profiles from anon, authenticated/);
assert(!/from\("profiles"\)\.select/.test(cloud), "Frontend must not read sensitive profile columns directly");
assert.match(html, /class="admin-card wide hidden" id="ownerBanCard"/); assert.match(html, /id="avatarRequestList"/);
assert.match(app, /protectedPages = new Set\(\["vault", "stress", "roadmap", "blogs", "blog-editor", "favorites", "checkin", "settings", "admin"\]\)/);
assert.match(cloud, /flowType: "pkce"|from "\.\/supabase\.js"/);
assert.match(html, /id="page-training-world"/); assert.match(html, /id="page-settings"/); assert.match(html, /id="trainingPrivacyForm"/);
assert.match(training, /fetchTrainingHeatmap/); assert.match(training, /data-bind-platform/); assert.match(cloud, /functions\.invoke\("training-bind"/);
for (const edge of ["training-bind/index.ts","training-sync-request/index.ts","training-sync-worker/index.ts","training-catalog-sync/index.ts","_shared/training.ts","_shared/ingest.ts"]) assert(existsSync(new URL(`../supabase/functions/${edge}`, import.meta.url)), `Missing Edge Function source: ${edge}`);
assert.match(sql, /unique\(platform,external_user_id\)/); assert.match(sql, /private\.training_access_audit/); assert.match(sql, /revoke all on public\.external_accounts[\s\S]*submission_events/);

console.log(`Static checks passed: ${ids.length} unique DOM ids, RLS on ${rlsTables.length} tables, env and workflow guards present.`);
