# Aurora 0.2 验证记录

2026-11-05，Windows x64；交付路径 `dist-aurora\win-unpacked\AI未来 Aurora.exe`，启动入口 `打开 Aurora.cmd`。整个发布目录约 488.2 MiB，需一起保留。

## 已完成

- `public-aurora/index.html`、`styles.css`、`app.js` 从零编写；旧 `public` 三文件与 `docs/archive/ui-v0.1/baseline.json` 的 SHA-256 完全一致。新版包不包含旧版前端。
- `npm test` 33 项通过，0 失败。新增覆盖 SQLite/WAL 只读快照、首次导入不覆盖新版数据、引用音频复制、主题跨随机端口与重启持久化、配置隔离和非法主题拒绝。
- 源码版及打包后的 EXE 均完成 11 组实际页面操作：聊天、记忆、慢请求草稿保护、模型失败后恢复、密钥不回显、TTS 文件保存且不自动播放、角色编辑、QQ 群聊与私聊沙盒、运行记录、明暗主题、手机角色浮层和 AIRI 真实舞台。
- 390px 聊天和连接页的页面滚动宽度均为 390px。已实际查看明暗桌面、手机和舞台截图，并进行独立代码及截图审查。
- 40 个源文件/文档的 UTF-8 无 BOM、乱码、JS/PowerShell 语法与 JSON 解析检查通过。10 个主要发布文件与源码哈希一致；发布包不包含个人数据库、登录态、QA、测试或日志。
- 通过真正的 `打开 Aurora.cmd` 正常启动。2026-11-05 17:08 的 Win32 检查确认主窗口 `Visible=true`、`Minimized=false`、`Responding=true`；标题为“林小璃 · AI-未来 Aurora”。首次旧库快照成功，旧数据原位保留。未关闭或覆盖旧程序。

## 证据

- 源码页面：`qa/aurora-source-03/complete.json`、`http-ui-report.json` 与七张截图。
- 打包页面：`qa/aurora-packaged-01/complete.json`、`http-ui-report.json` 与七张截图。
- 正常启动：`qa/aurora-normal-start/result.json`。
- 设计检测：`qa/aurora-design-detect.json`。没有对比度或字号下限问题；剩余提示为设计文档的非穷尽色值/响应式尺寸记录，以及舞台占位图标、玻璃控件嵌于面板的结构提醒。保留了用户指定参考中的玻璃材质与圆角层次，经实际截图审查无阻断问题。

模型与语音使用本地隔离测试服务；QQ 使用本地协议测试端与沙盒。未调用真实外部模型、未连接真实 QQ、未播放音频。AIRI 仍使用原有示例形象，角色模型/声音同步与 QQ 语音条、表情包的能力边界不因 UI 重做而改变。
