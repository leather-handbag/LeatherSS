# Leather Support Station

Leather SS 是面向信息学竞赛训练的轻量型工作站。目前尚未完善。访客可以阅读公开文章、个人主页和排行榜；登录后可以使用模板库、对拍、任务导图、博客、评论和每日签到并 rngdle 一下。

## 目前功能

- Supabase 邮箱密码与 GitHub OAuth 登录，支持经管理员审核的头像、名字、唯一 ID、简介和修改密码。
- 模板分区、标签、版本快照和 Diff；模板按账号存储，不再要求单独的模板密码。
- JavaScript 在线对拍与 C++14 PowerShell 对拍脚本。
- 云端分层任务导图。
- 私有/公开博客、Markdown、KaTeX、文章评论和工作站留言。
- 每日安全随机六位数字、稀有度评级、签到等级分、排行榜和用户搜索。
- 站长/管理员后台、RLS 权限、自动内容审核、删除封禁和审计记录。

## 本地启动

要求 Node.js 22.12 或更高版本。本机 Node 位于 `D:\node.exe`，npm 位于 `D:\npm.cmd`；若没有加入 PATH，可把下列 `npm` 替换为 `D:\npm.cmd`。

```bash
npm install
```

复制 `.env.example` 为 `.env`，填写 Supabase Dashboard → Project Settings → Data API 中的项目参数：

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```

只允许在前端使用 publishable/anon key。绝对不能把 `service_role` key 写进 `.env`、源码或 GitHub Secrets 的前端构建变量。

在 Supabase SQL Editor 执行 [202607130001_leather.sql](supabase/migrations/202607130001_leather.sql)，然后启动：

```bash
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

本地静态检查与生产构建验证：

```bash
npm test
```

真实远端权限回归脚本位于 `tests/remote-check.mjs`。它需要临时注入管理访问令牌和 `service_role`，只应由项目所有者在受控终端运行，绝不能把这些值写入前端环境变量。

## 认证配置

1. Supabase Authentication → URL Configuration：Site URL 填线上 GitHub Pages 地址。
2. Redirect URLs 同时加入线上地址和本地地址，例如 `http://localhost:5173/**`。
3. 邮箱登录建议开启 Confirm email，并配置正式 SMTP。
4. GitHub 登录需要在 GitHub 创建 OAuth App，再把 Client ID/Secret 填入 Supabase Authentication → Providers → GitHub。
5. Turnstile Site Key 使用前端变量 `VITE_TURNSTILE_SITE_KEY`；Secret Key 只填 Supabase Authentication → Configuration → Attack Protection，绝不能写入仓库或任何 `VITE_` 变量。
6. 建议在 Supabase 开启合理的 Auth/API Rate Limits；泄漏密码检查需要支持该功能的 Supabase 套餐。

当前项目已配置线上/本地回调地址、最短 8 位密码、正式 SMTP、GitHub Provider 和 Turnstile，站长账号也已绑定。Supabase 远端已保存 Secret 并启用服务端 CAPTCHA 强制校验，具体状态见 [SUPABASE_SETUP_REPORT.md](SUPABASE_SETUP_REPORT.md)。

## 绑定站长

`leather-handbag` 是保留 ID，但名字本身不能证明身份。首次注册并登录后，在 Supabase Authentication → Users 复制你自己的 UUID，以项目所有者身份执行：

```sql
update public.profiles
set role = 'owner',
    handle = 'leather-handbag',
    display_name = 'leather-handbag',
    updated_at = now()
where id = 'YOUR_AUTH_UUID';
```

必须检查只更新了一行，并确认 UUID 属于你的账号。普通用户不能抢注此 ID，也不能自行修改角色。

## GitHub Pages

仓库已包含 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)。在 GitHub 仓库 Settings → Secrets and variables → Actions 新建：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

然后在 Settings → Pages 将 Source 设置为 GitHub Actions。工作流会执行 `npm ci`、注入环境变量、构建 `dist` 并部署。

`.env`、`.env.*`、`node_modules` 和 `dist` 已加入 `.gitignore`，仅 `.env.example` 可以提交。

## 权限规则

- 未登录用户只能读取公开文章、安全公开资料和排行榜。
- 作者只能新增、修改或删除自己的博客、评论、模板和计划。
- 管理员可以查看所有博客、模板和计划，可以删除普通用户内容、封禁普通用户并审核普通用户头像，但不能解封或操作站长/其他管理员。
- 站长可以查看带原因的专属封禁列表、解封、审核全部头像、授权管理员和解除管理员；任何人都不能通过前端修改自己的角色、封禁状态或已批准头像。
- 名字颜色：负分灰、0–4 蓝、5–9 绿、10–29 橙、30 以上红；管理员和站长固定紫色。
- 签到日 +5 分；已经结束且漏签的日期 -1 分。分数由签到记录实时计算，不依赖定时任务。

## 内容安全

- 浏览器先做 Unicode、零宽字符、符号拆分和部分形近字符检查。
- 数据库触发器再次审核博客、评论、留言、资料、模板、快照和计划；命中后删除/清空内容、记录事件并停止该账号写入。
- 对拍代码在运行前调用服务端审核 RPC；命中后删除本地对拍内容并封禁写入权限。
- RLS 和服务端触发器才是最终安全边界，不能信任前端检查。
- Markdown 原始 HTML 会被转义，链接仅允许 HTTP/HTTPS；KaTeX 使用 `trust: false` 和 SRI 完整性校验。

完整的远端配置步骤、未完成项和风险见 [SUPABASE_SETUP_REPORT.md](SUPABASE_SETUP_REPORT.md)。

## 对拍约定

JavaScript 模式中，正解和暴力定义 `solve(input)`，生成器定义 `generate(seed)`；生成器可以调用 `rnd(l, r)`。代码在 Web Worker 中运行，单次任务最长 20 秒。

C++14 模式会下载 PowerShell 脚本，本机需要安装 `g++` 并加入 `PATH`。
