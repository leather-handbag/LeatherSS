import { createClient } from "@supabase/supabase-js";

const url = String(import.meta.env.VITE_SUPABASE_URL || "").trim();
const key = String(import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();
export const turnstileSiteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY || "").trim();
export const turnstileConfigured = /^0x[A-Za-z0-9_-]{20,}$/.test(turnstileSiteKey);

export const supabaseConfigured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) && key.length > 40;
export const supabase = supabaseConfigured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce"
      },
      global: { headers: { "X-Client-Info": "leather-web/2.0" } }
    })
  : null;

export function supabaseErrorText(error) {
  const message = error?.message || String(error || "未知错误");
  if (/invalid login credentials/i.test(message)) return "邮箱或密码不正确";
  if (/email not confirmed/i.test(message)) return "请先打开验证邮件完成邮箱确认";
  if (/user already registered/i.test(message)) return "这个邮箱已经注册";
  if (/captcha|challenge/i.test(message)) return "请完成人机验证后重试";
  if (/rate limit/i.test(message)) return "操作过于频繁，请稍后重试";
  if (/row-level security|permission denied/i.test(message)) return "没有执行此操作的权限";
  if (/failed to fetch|network/i.test(message)) return "无法连接 Supabase，请检查网络和环境变量";
  return message;
}
