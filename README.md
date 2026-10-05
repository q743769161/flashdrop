# ⚡闪传 flashdrop

手机 ↔ 电脑互传文字和文件，不用登录微信 / QQ，打开网页就能用。

- **纯 Cloudflare 部署**：Worker + R2，无服务器、无 KV
- **密码保护**：打开网站先输密码（自己设），传的东西只有自己能看
- **传文字**：发一段文字，所有设备同步可见，一键复制
- **传文件**：拖拽 / 点选上传（可多选），带进度条，下载、删除
- **自动清理**：文件默认 7 天后自动删除（上传时可选 1 / 7 / 30 天），文字默认保留 30 天，每天凌晨自动清理

## 上线步骤（5 分钟）

> 代码已在 GitHub，后续更新只需 `git push`，Cloudflare 会自动同步部署。

1. **建 R2 存储桶**
   Cloudflare 后台 → R2 → Create bucket，名字填 `flashdrop-files`（地区随便选）

2. **连接 GitHub 仓库**
   Workers & Pages → Create → Connect to Git → 选中本仓库 → Deploy。
   构建设置保持默认即可（本项目是单文件 Worker，无需构建命令）。

3. **绑定 R2**
   进这个 Worker → Settings → Bindings → Add binding → R2 bucket：
   Variable name 填 `BUCKET`，Bucket 选 `flashdrop-files`

4. **设置访问密码**
   Settings → Variables → Add variable：
   变量名 `AUTH_PASSWORD`，值填你想要的密码，**点 Encrypt 加密**，Save。
   （可选：再加 `FILE_TTL_DAYS` 改默认文件保留天数）

5. **重新部署**（Deployments → Redeploy，或随便 push 一次代码），打开分配的 `*.workers.dev` 域名就能用。

以后想换密码、改保留天数，直接在 Variables 里改，不用动代码。

## 用量面板

页面底部有一块「用量」：**R2 存储**（已用 / 10GB、文件数）开箱即用，无需配置。

**今日 Workers 请求数**需要两个额外变量才会显示：

1. Cloudflare 后台 → 右上角头像 → My Profile → API Tokens → Create Token → Create Custom Token
2. 权限选 Account → Account Analytics → Read；Account Resources 选你的账号 → Continue to summary → Create Token，复制 token
3. 回到 flashdrop Worker → Settings → Variables：添加 Secret `CF_API_TOKEN`（粘贴 token，点 Encrypt），再添加普通变量 `CF_ACCOUNT_ID`（Account ID 在 Workers & Pages 总览页右侧可以找到）
4. Redeploy。之后用量面板会多一行「今日 Workers 请求 X / 100,000」（免费版每日限额）

## 本地开发（可选）

```bash
npx wrangler dev
```

## 文件说明

| 文件 | 说明 |
|---|---|
| `worker.js` | 全部代码：后端 API + 内嵌前端页面，单文件 |
| `wrangler.toml` | Worker 配置（R2 绑定、定时清理、默认变量） |

## R2 里的数据结构

- `texts/index.json` — 文字列表 `[{id, text, createdAt, expiresAt}]`
- `files/index.json` — 文件索引 `[{id, name, size, key, uploadedAt, expiresAt}]`
- `files/<id>/<文件名>` — 文件本体

## 注意事项

- 免费版 Worker 单次请求体建议 **100MB 以内**，传超大文件可能失败；日常截图、文档完全没问题
- R2 免费额度 10GB 存储 / 每月 1000 万次 A 类操作，个人用绰绰有余
