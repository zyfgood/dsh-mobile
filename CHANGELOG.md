# Changelog

## 0.1.0 — 2026-10-22

首个公开版本。

- 独立的手机端 HTTP(S) 服务，绑定 `0.0.0.0:35888`（端口占用可自动顺延），不改变桌面 Web GUI 的 loopback 绑定。
- 访问令牌 + HMAC 签名 HttpOnly Cookie、登录限速、Origin/Sec-Fetch-Site 检查、CSP、请求体上限。
- 会话列表、搜索、空白会话开关、运行状态、任务进度。
- 会话历史分页、SSE 实时事件、模型流式输出（`assistant-stream`）、断线重连。
- 继续对话、停止回复、新建会话；子代理会话默认隐藏且只读。
- 手机端 Markdown（标题/列表/表格/代码块/链接/粗体/斜体）、思考过程与工具调用折叠。
- 桌面 GUI 左下角 📱 面板：二维码、访问链接、实际端口和服务状态。
- PWA manifest、SVG/PNG 图标、登录页与暗色/亮色自适应。
- DSH 插件清单：`dsh.bundle.patch` + `dsh.client` + `dsh.catalog`。
- desktop profile 本地安装脚本（含备份、幂等检查）。
