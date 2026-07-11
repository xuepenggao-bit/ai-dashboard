# 仪表板 JSON 同步 Worker

这个 Worker 保留 GitHub 中的 `portfolio.json` 和 `data/preflight_log.json` 作为持久化文件。浏览器不再直接访问 GitHub API，也不需要录入 GitHub token。

## 部署一次

1. 注册并登录 Cloudflare，进入 **Workers & Pages**，创建 Worker。
2. 将 [`portfolio-sync-worker.js`](portfolio-sync-worker.js) 的内容粘贴到 Worker 编辑器并部署。
3. 打开 Worker 的 **Settings → Variables and Secrets**：
   - 添加 **Secret**：`GITHUB_TOKEN`。值为 GitHub fine-grained PAT，只选择 `ai-dashboard` 仓库，授予 `Contents: Read and write`。
   - 若还要让页面的 `↻` 按钮触发 GitHub Actions，额外授予 `Actions: Read and write`。
   - 添加普通变量：`ALLOWED_ORIGIN`，值为 `https://financial.qiwu.fun`。
4. 复制 Worker 地址，例如 `https://ai-dashboard-sync.<你的子域>.workers.dev`。
5. 将仓库根目录的 [`portfolio-sync-config.js`](../portfolio-sync-config.js) 改为：

   ```js
   window.AI_DASH_SYNC_API = 'https://ai-dashboard-sync.<你的子域>.workers.dev';
   ```

6. 提交该配置文件。之后所有浏览器和手机都会自动使用同一份 GitHub JSON，不再要求输入 PAT。

## 风险说明

本方案刻意没有用户登录。`ALLOWED_ORIGIN` 只是一层浏览器 CORS 限制，不是安全认证；知道 Worker 地址的人仍可能构造请求修改这两个 JSON 文件。GitHub PAT 仍安全地保存在 Cloudflare Secret 中，不会出现在仓库或浏览器内。
