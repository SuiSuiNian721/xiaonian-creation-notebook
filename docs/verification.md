# Demo 0.1.0 验证记录

验证日期：2026-11-05。交付目录：`dist\win-unpacked`，Windows x64 便携版，约 488.1 MiB；整个目录需要一起保留。

## 已验证

- `npm test`：22 项通过，0 失败。包含原生 SQLite 持久化、会话与记忆隔离、密钥脱敏、模型与语音接口、OneBot 本地 WebSocket、发送确认与失败、重连期间旧回复隔离、名单撤销、无效帧处理及 AIRI 资源边界。
- 源码和最终打包 EXE 均在独立数据目录、隐藏离屏 Electron 中操作真实控件：发送聊天、保存与删除记忆、重载后的记忆范围、配置模型与语音、失败保留输入和恢复、语音文件保存及播放器不自动播放、QQ 群聊 @ 与私聊沙盒、运行记录。
- 390px 聊天与连接页：页面宽度与滚动宽度均为 390px。桌面、手机和舞台截图经过实际查看及独立审查。
- AIRI 舞台在打包版中真实加载 ThreeScene、WebGL Canvas、VRM 示例和待机动画；素材随包提供，未改原 AIRI 安装。
- 代码语法、JSON 解析、UTF-8 无 BOM 与常见乱码检查通过。发布目录未包含 SQLite、个人配置、登录态、测试数据库、日志或 QA 截图；8 个主要运行文件与源码 SHA-256 一致。

最终打包版的结果：`qa\packaged-final\complete.json`、`http-ui-report.json`，以及同目录的四张截图。源码离屏结果：`qa\source-offscreen`。

## 证据范围

模型和语音使用隔离的本地模拟服务；语音生成的是用于验证传输与保存的静音 WAV，没有实际调用外部模型、声音克隆服务或播放音频。OneBot 测试端和 QQ 沙盒不代表真实 QQ 账号联调已经完成。

舞台使用 AIRI 示例形象，未替换为林小璃，未接自定义模型、口型与对话同步。QQ 语音条、表情包、图片理解与主动发言尚未实现。Windows 正常窗口的关闭与托盘策略经过源码审查，未操作念念正在使用的窗口。

AIRI 主体的 MIT 许可与素材授权边界见 `THIRD_PARTY_NOTICES.md`。本轮交付用于本机体验，没有执行对外发布或自动安装。

## 正常启动修复

念念反馈双击 CMD 后无可见窗口。现场检查确认正常实例和主窗口已经创建，但 `IsWindowVisible` 为 false；`Start-Demo.ps1` 将交互式程序以 `WindowStyle Hidden` 启动。离屏 QA 没有覆盖此启动策略。

启动器已改为 `WindowStyle Normal`。通过原 `打开 Demo.cmd` 入口复查：返回码 0，原实例主窗口恢复可见、未最小化且正常响应；窗口截图实际显示工作台。记录位于 `qa\startup-repair\result.json` 与 `visible-window.png`。此次只修改启动器显示策略，保留既有数据库与程序实例。
