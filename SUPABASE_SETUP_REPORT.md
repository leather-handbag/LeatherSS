# Supabase 配置、验收与剩余人工项

## 已完成

- 已安装 `@supabase/supabase-js` 2.110.3 与 Vite 8.1.4，并使用 `D:\node.exe` / `D:\npm.cmd` 完成安装、测试和构建。
- 已创建本地 `.env`，写入项目 URL 与 publishable key；`.env` 已被 `.gitignore` 排除，前端和仓库中没有 `service_role`。
- 已将 [202607130001_leather.sql](supabase/migrations/202607130001_leather.sql) 实际应用到 `leather-handbag's Project`（项目引用 `gizauzokmalddnkjdgxw`）。
- 已验证 10 张业务表全部启用 RLS，匿名和登录角色均不能直接读取 `profiles` 敏感列。
- 已部署博客、文章评论、工作站留言、模板、快照、计划、签到、排行榜、管理员 RPC、封禁审计和敏感词审核。
- 已部署头像申请表与审批 RPC。用户只能提交候选头像，普通管理员只能审核普通用户，站长可审核全部；未审批头像不能写入公开资料。
- 已部署仅站长可调用的封禁列表 RPC，保存封禁时间和原因；普通管理员不能读取或解封。
- 已修复 Windows 管理 API 请求导致的中文 SQL 编码问题。远端现有 60 条敏感词、0 条乱码，7 个分类计数正确。
- 已把 Auth Site URL 设为 `https://leather-handbag.github.io/LeatherSS/`，并加入线上、本地 5173 与预览 4173 回调白名单。
- 已把 Auth 最短密码提高到 8 位。当前基础限流为邮件 2、验证 30、OTP 30、令牌刷新 150。
- 已确认项目中唯一真实账号已绑定为 `owner`，公开 ID 与显示名称均为 `leather-handbag`。
- 已配置并启用 GitHub OAuth Provider；授权端点实测返回 302 并正确跳转到 GitHub。
- 已配置正式 SMTP，邮箱确认保持开启。
- 已接入 Cloudflare Turnstile 前端组件，公开 Site Key 通过 Vite 构建变量注入；邮箱登录、注册与密码重置都会提交一次性 CAPTCHA Token，并处理过期、超时、失败和使用后重置。
- GitHub Pages 已部署到 `https://leather-handbag.github.io/LeatherSS/`，最新 Actions 部署状态为成功。
- 已完成四角色远端回归：访客、普通用户、管理员、站长。13 组权限与业务检查全部通过，临时账号、头像和无主审计记录已清理为 0。
- 已完成桌面和窄屏界面截图验收，加入响应式修复、状态色、进入动效、代码窗指针反馈及 `prefers-reduced-motion` 降级。

## 仍需处理的外部安全项

### 1. Supabase CAPTCHA 尚未启用

前端 Site Key 与验证流程已经完成，但远端 Auth 配置仍显示 `captcha_enabled=false`，没有 CAPTCHA Provider 或 Secret。请在 Supabase Authentication → Bot and Abuse Protection 选择 Cloudflare Turnstile、填入 Secret Key 并启用 CAPTCHA。Secret 绝不能发送到聊天、写入仓库或放进任何 `VITE_` 环境变量；公开 Site Key 已经配置，无需再次提供。

### 2. 泄漏密码检查的套餐限制

已尝试启用 HaveIBeenPwned 泄漏密码检查，Supabase 返回 HTTP 402：该功能仅 Pro 及以上套餐可用。当前仍有最短 8 位密码和 Auth 限流，但免费套餐无法启用此检查。

## 已通过的远端验收

- 访客只能读取公开文章和公开资料。
- 其他普通用户不能读取私有文章，也不能给私有文章评论。
- 管理员可读取全部业务内容、封禁普通用户和审核普通用户头像。
- 管理员不能封禁站长、不能解封、不能读取站长封禁列表。
- 站长可查看封禁原因、解封、授权和解除管理员。
- 敏感内容会被硬删除，账号会被应用层封禁，站长可解封。
- 签到每日幂等，安全随机函数已限定到 Supabase 的 `extensions.gen_random_bytes`。
- 头像只有审核通过后才进入 `profiles.avatar_url`。
- 测试结束后 Auth 测试用户、测试资料、头像对象和无主审计记录均为 0。

## 仍然存在的生产风险

1. 自动硬删除和永久封禁可能误伤引用敏感词的题解或安全研究内容；当前实现严格遵循要求，误伤只能由站长解封，正文无法恢复。
2. 管理员按要求能读取私有博客、模板和计划，应只授权高度可信人员。
3. 待审核头像位于公开 Storage bucket，随机路径很难猜测，但知道完整 URL 的人仍可直接访问；真正的图片内容识别仍需第三方审核或人工审核。
4. 应用层封禁会阻止所有写入，但不会删除 Supabase Auth 会话；Auth 层彻底禁用需要服务端 Edge Function，`service_role` 绝不能进入前端。
5. Turnstile 只有在 Supabase 保存 Secret 并启用后才会由服务端强制校验；WAF/CDN、备份和告警仍是上线安全的一部分。
6. 旧版 `localStorage` 数据不会自动上传，避免把旧草稿误公开或触发自动封禁；迁移前应先备份并人工检查。
