# 独立实时日志与浏览器自动打开验证

交付版本：桌面工作台 v0.8.2。实现提交：`a502ecf`。

## 实际使用

2026-11-07 在正式资料目录、打包后的工作台中，用真实鼠标点击 ComfyUI 启动器的“启动 ComfyUI”。没有通过接口代替启动按钮。

- 00:42:24 请求启动本机 ComfyUI，独立日志窗口自动出现并持续显示实际输出。
- 00:42:26 仍未连接，自动打开状态为 `waiting`，未提前打开浏览器。
- 00:43:02.670 完成 ComfyUI 0.42.0 的状态与节点定义握手，识别 RTX 4060 Laptop GPU。
- 00:43:02.735 自动打开浏览器。实际查看系统 Edge 的 ComfyUI 标签，地址为 `127.0.0.1:8188`，原有工作流保持原样。
- 实际点击独立日志窗口的“复制全部”，从系统剪贴板读回 59326 个字符的 ComfyUI 输出，窗口显示“已复制日志”。检查结束后恢复此前剪贴板数据。

证据位于 `qa/live-user-use/`：

- `final-start.json`：启动前后的真实连接和自动打开状态。
- `native-clipboard-final.json`：正式包、真实鼠标、系统剪贴板读回成功。
- `21-final-real-logs.png`：实际日志窗口及复制成功反馈。
- `22-auto-opened-browser.png`：实际打开的浏览器与本机地址。

## 源码与桌面检查

- 指定本机 Python 后，完整 Node 测试 **296/296 通过，0 跳过**。
- `qa/process-log-final-source/result.json`、`qa/process-log-final-packaged/result.json`：各六组 GUI 检查通过，覆盖自动弹窗、服务就绪后打开浏览器、窗口去重、关闭重开、实时输出、跟随、保存、安装失败、窄窗与缩放。
- `qa/launcher-autobrowser-source/result.json`、`qa/launcher-autobrowser-packaged/result.json`：各十二组启动器回归检查通过。
- GUI 安装检查使用真实临时 Node 子进程输出，未执行真实 pip 安装。该 GUI 检查中的剪贴板适配器只验证交互逻辑；系统剪贴板以正式包的原生回读结果为准。
- 独立审查核对了界面、权限边界、进程生命周期及握手期间退出/替换的竞态。

原生检查曾发现旧桌面权限规则阻止剪贴板写入，现仅向当前同源日志页开放 `clipboard-sanitized-write`；其他来源与权限继续拒绝。握手前后均核对启动进程身份，避免进程已退出后仍打开浏览器。

## 构建与边界

新版位于 `dist-workbench-logs/win-unpacked/`，原来的 `Start-Workbench.ps1` 优先选择该版本，顶层快捷方式沿用原入口。

构建记录生成时实现还未提交，因此原始 `build-record.json` 保留 `sourceDirty:true`。交付校验将包内 **78 个文件**与当前已提交源码及构建哈希逐一比对，结果另存 `dist-workbench-logs/release-verification.json`，不改写原始构建历史。

日志窗口专项检查已实际验证冷启动、日志显示、复制及浏览器打开，没有执行真实依赖安装。随后继续完成了 MCP 接入、界面工作流生成与实际生图，详见 `docs/workbench-real-use-verification.md`。
