# 雪球热股榜配置

雪球热股榜接口需要登录态。请将完整 Cookie 存在 GitHub Actions Secret 中，切勿写入仓库、前端代码或 Issue。

1. 在浏览器登录雪球，打开开发者工具的 Network 面板，刷新任意雪球页面。
2. 打开一个 `xueqiu.com` 或 `stock.xueqiu.com` 请求，从 Request Headers 复制完整的 `Cookie` 值。
3. 在仓库 **Settings → Secrets and variables → Actions** 创建名为 `XQ_COOKIE` 的 repository secret，粘贴完整值。
4. 在 Actions 中手动运行 **Refresh Portfolio Data (热股榜 + 权重股舆情)**，确认 `data/xq_hot.json` 出现非空 `list`。

Cookie 至少须包含 `u` 和 `xq_a_token`。当前工作流仍兼容旧的 `XQ_TOKEN`，但它不再是推荐配置；仅有 token 容易过期或被雪球拒绝。

如果有效完整 Cookie 在 GitHub-hosted runner 上仍被雪球拦截，请将该工作流改到你的自托管 runner（家庭/办公网络）。雪球会识别数据中心 IP；更换请求头无法保证绕过这类访问控制。
