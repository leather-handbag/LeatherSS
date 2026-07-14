import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const html = read("index.html"), app = read("app.js"), cloud = read("cloud.js"), client = read("supabase.js");
const sql = read("supabase/migrations/202607130001_leather.sql"), ignore = read(".gitignore"), workflow = read(".github/workflows/deploy.yml");
const pkg = JSON.parse(read("package.json"));

assert.equal(pkg.dependencies["@supabase/supabase-js"], "2.110.3", "Supabase SDK version missing");
assert.match(ignore, /^\.env$/m); assert.match(ignore, /^\.env\.\*$/m); assert.match(ignore, /^!\.env\.example$/m);
if (existsSync(new URL("../.env", import.meta.url))) {
  const env = read(".env");
  assert.match(env, /^VITE_SUPABASE_URL=https:\/\/.+\.supabase\.co$/m);
  assert.match(env, /^VITE_SUPABASE_ANON_KEY=\S+$/m);
  assert(!/service_role/i.test(env), "Local frontend env must never contain service_role");
}
assert(!/service_role/i.test(client + cloud + app), "Frontend source must never contain service_role");
assert.match(workflow, /VITE_SUPABASE_URL: \$\{\{ secrets\.VITE_SUPABASE_URL \}\}/);
assert.match(workflow, /VITE_SUPABASE_ANON_KEY: \$\{\{ secrets\.VITE_SUPABASE_ANON_KEY \}\}/);
assert.match(workflow, /VITE_TURNSTILE_SITE_KEY:[^\n]+vars\.VITE_TURNSTILE_SITE_KEY/);
assert.match(client, /VITE_TURNSTILE_SITE_KEY/); assert.match(cloud, /captchaToken/); assert.match(app, /turnstile\.render/);
assert(!/TURNSTILE_SECRET/i.test(client + cloud + app + html), "Turnstile Secret must never enter frontend source");

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(v => v[1]);
assert.equal(new Set(ids).size, ids.length, "Duplicate HTML id detected");
const dynamic = new Set(["articleCommentContent","articleCommentForm","articleCommentList","deleteSectionCheck","deleteTaskCheck","editSectionColor","editSectionName","levelColor","levelName","levelNote","newPageLang","newPageName","newSectionColor","newSectionName","restoreVersionBtn","taskDesc","taskDue","taskTitle","turnstileScript"]);
const refs = [...app.matchAll(/\$\("#([A-Za-z][A-Za-z0-9_-]*)"/g)].map(v => v[1]);
const missing = [...new Set(refs.filter(id => !ids.includes(id) && !dynamic.has(id)))];
assert.deepEqual(missing, [], `Missing static DOM ids: ${missing.join(", ")}`);

const rlsTables = ["profiles","avatar_requests","posts","post_comments","station_comments","template_sections","templates","template_snapshots","plans","daily_checkins"];
for (const table of rlsTables) {
  assert(sql.includes(`alter table public.${table} enable row level security;`), `RLS missing for ${table}`);
}
for (const feature of ["daily_checkin()","admin_ban_user","owner_unban_user","owner_set_admin","enforce_text_policy","moderate_written_content","public_profile_stats","submit_avatar_request","review_avatar_request","owner_list_banned_users","admin_list_users","get_my_profile"]) {
  assert(sql.includes(feature), `SQL feature missing: ${feature}`);
}
assert.match(sql, /handle\s*=\s*'leather-handbag'/); assert.match(sql, /target_id[\s\S]*role = 'owner'/);
assert.match(sql, /new\.avatar_url\s*:=\s*old\.avatar_url/);
assert.match(sql, /revoke all privileges on public\.profiles from anon, authenticated/);
assert(!/from\("profiles"\)\.select/.test(cloud), "Frontend must not read sensitive profile columns directly");
assert.match(html, /class="admin-card wide hidden" id="ownerBanCard"/); assert.match(html, /id="avatarRequestList"/);
assert.match(app, /protectedPages = new Set\(\["vault", "stress", "roadmap", "blogs", "checkin", "admin"\]\)/);
assert.match(cloud, /flowType: "pkce"|from "\.\/supabase\.js"/);

console.log(`Static checks passed: ${ids.length} unique DOM ids, RLS on ${rlsTables.length} tables, env and workflow guards present.`);
