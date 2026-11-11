# 桌面入口

桌面「小念的创作笔记」通过固定入口配置启动当前交付源码，不使用历史 `dist-*` 包。源码更新后关闭并重新打开程序即可加载新版；已经打开的窗口保留当前进程中的代码。1.0 更名仍沿用 `AI-Future-Workbench` 内部资料与入口目录，不迁移已有资料。

## 安装与更新

在准备交付的源码目录，用 PowerShell 7 执行：

```powershell
pwsh -NoProfile -File '.\tools\Install-WorkbenchDesktop.ps1'
```

首次可用 `-ProfileDirectory '<现有资料目录>'` 指定资料。再次执行时自动保留已登记的资料路径，只更新源码与运行时目标，不迁移、复制或覆盖角色、聊天与密钥。

入口配置与启动脚本位于 `%LOCALAPPDATA%\AI-Future-Workbench\desktop-entry`，修改前备份现有配置和快捷方式。桌面快捷方式始终指向这个固定目录；更换分支或交付目录后，从新目录重新运行上述安装命令。

当前源码入口为 `E:\智能，生命。\AI-未来工作台\主项目\ai-future-demo` 的 `main`。资料沿用 `E:\智能，生命。\AI-未来工作台\分支\ai-future-character-life\artifacts\character-life-preview-profile`，包括已导入的小汐。它是桌面入口正在使用的资料，不是可随意清理的测试缓存。现有 `%APPDATA%\AI-Future-Workbench` 正式资料保留原位。

## 每次交付

- 从最终源码目录重新运行安装命令，保留既有资料路径。
- 回读桌面快捷方式和入口配置，确认源码位置及资料目录。
- 实际打开桌面入口：已有实例应聚焦原窗口；完整重启后核对加载的新版本和角色资料。
- 更新验证结果写入交付说明。禁止只提交源码却把桌面入口留在旧程序包。

子进程日志直接写入所选资料的 `logs`，启动终端退出不会切断日志管道；最近一次启动记录为 `logs/desktop-entry-last-launch.json`。启动失败显示错误窗口。

## 本次验证

2026-11-07 实际从桌面快捷方式启动当前源码，工作台首页正常载入，林小汐仍为当前角色。再次点击入口复用同一个进程；不传资料参数重新安装入口后，资料路径保持不变。启动器的终端退出、文件日志和两种初始页面回归共 2 项通过。实际启动记录见当前工作区 `artifacts/desktop-entry-verification.json`。

同日合并 ComfyUI 预览与虚拟陪伴后，从 `main` 重新安装入口，正常关闭旧窗口并启动新进程。入口配置、进程命令行和实际页面资源均确认来自 `main`；重启前后全局角色、用户资料及原运行实例的人设内容一致，5 个实例标识保留。此次记录见 `qa/main-merge/desktop-after.json` 与 `docs/handoffs/2026-11-07-main-comfy-companion.md`。
