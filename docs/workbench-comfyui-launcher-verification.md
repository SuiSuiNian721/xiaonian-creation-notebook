# 绘图与启动器 0.7.0 验证记录

日期：2026-11-06。范围为念念已确认的两个独立左侧入口、工作流/AI/MCP 集中创作、高级启动参数与原管理流程兼容。源码保留在 `feat/comfyui-launcher-workspace`；用法见 [启动器说明](workbench-comfyui-launcher.md)。

## 程序与入口

- 统一入口：`E:\智能，生命。\AI-未来工作台\打开 AI-未来工作台.lnk`。
- 新包：`分支/ai-future-drawing-manager/dist-workbench-launcher/win-unpacked/AI未来 工作台.exe`，0.7.0，Electron 44.4.5。
- 构建源：`86ff0a81eef27270b4a053b5d022ca92f4122586`，构建时工作区干净；后续收尾提交仅更新启动脚本、计划和本记录。
- 内外 `build-record.json` 一致，记录 9 个模块、构建源与 **68 个核心文件 SHA256**；构建器和构建后的独立比较均通过。
- 统一入口仍指向本分支的 `打开工作台.cmd`，脚本实际选择已验收的 0.7.0 路径。此项用进程启动替身执行脚本验证，没有重启正式窗口。
- 入口、本目录说明与启动脚本升级前备份：`备份/启动器升级前入口-20261106-181737`。0.6.0 的 `dist-workbench-next` 保留。

已有窗口继续运行；关闭后重新打开统一入口才进入新版。正式资料仍使用 `%APPDATA%\AI-Future-Workbench`。本轮候选 EXE 使用独立 profile/data 验收，没有读取正式角色、聊天或密钥，也没有迁移作品。

## 验证结果

证据路径均相对于本工作区。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 完整 Node 回归 | **270/270，0 失败、0 跳过**；设置真实 Python 路径，包含纯 AST 和工作流转换 | `qa/launcher-split/unit-full.log` |
| 新启动器源码 GUI | 12 组通过，无页面错误 | `qa/launcher-split/ui-final/result.json` |
| 最终 EXE：启动器与工作流拆分 | **12 组通过**，无页面错误 | `qa/launcher-split/packaged-launcher/result.json` |
| 最终 EXE：原绘图流程 | **9 组通过**，无页面错误 | `qa/launcher-split/packaged-drawing/result.json` |
| 最终 EXE：管理、下载与快照 | **7 组通过**，无页面错误 | `qa/launcher-split/packaged-manager/result.json` |
| 最终 EXE：工作台整体 | **32 组通过**，无页面错误 | `qa/launcher-split/packaged-workbench/result.json` |
| 最终 EXE：原生关闭 | 关闭前未保存聊天草稿实际落盘 | `qa/launcher-split/packaged-workbench/lifecycle-result.json` |
| AIRI Minecraft 随包依赖 | 隔离执行器自检通过 | `qa/launcher-split/package-07.log` |
| 包与源码一致性 | 0.7.0 / 9 模块 / 68 核心文件逐字节一致 | `qa/launcher-split/package-identity.json` |
| 入口与旧包保留 | 脚本选择新版；旧包存在，正式旧窗口保持运行 | `qa/launcher-split/entry-verification.json` |

JS 与 PowerShell 语法、UTF-8 无 BOM、乱码扫描和 `git diff --check` 通过。浅深色、125% 缩放与 390px 两个工作区无页面横向溢出；参数单项还原的窄窗口也已检查。

启动器 GUI 使用真实临时 Node 子进程，验证启动日志、工作台持有进程的停止与实际退出；构造给 ComfyUI 的参数数组也被核对。工作台管理回归使用真实临时 Git 仓库、文件和本地 HTTP/Range 服务。ComfyUI、Python 诊断结果与 AI 回答在 GUI 中使用夹具；剪贴板测试采用隔离适配器，客户端 JSON 则经过实际下载。

## 审查中修正的边界

需求和质量复核均已通过；以下问题各有先失败、修正后通过的记录：

- 能力过期后，旧布尔/数字设置可单项回默认；保存保留其他参数且不启动。
- 当前 CLI 移除的 fast 旧勾选允许单独取消，取消后不可重新选入，其他有效优化保持。
- 不可用选择的原因进入可聚焦、可点击的字段 info，键盘/触屏不依赖禁用 option 的 `title`。
- 公共 AI 草稿中的旧 MCP 值会随专用保存更新；模型、密钥与明确不同的 MCP 草稿保留。
- 工作流助手基础项与明确「新建」保持草稿；编写和采用互斥，慢预检不会清掉另一份新候选。
- 慢保存和诊断不覆盖继续编辑的数字、多选草稿；离页结果不写入新页。

对应记录包括 `recovery-red`、`mcp-draft-red`、`removed-fast-red-03`、`assistant-base-red`、`assistant-concurrency-red` 与最终 `ui-final`。旧参数回退的后端修正位于 `c074dae`。

## 本机只读证据与运行边界

`qa/launcher-split/local-cli-readonly.json` 由真实 Python 对本机 `E:\ai draw\ComfyUI-aki-v2\ComfyUI\comfy\cli_args.py` 仅做 AST 读取：发现 114 个参数声明，`PerformanceFeature` 为 `fp16_accumulation`、`fp8_matrix_mult`、`cublas_ops`、`autotune`；CLI SHA256 为 `e9f1b03f9475f14cf834600fdc5ef67a06d9ea1c2da2931a6ed8b874d4f59f9c`。

这只证明当前文件的声明，不证明可选注意力包与具体 GPU/模型能运行。实际启动前仍按当前 Python、本体与 CLI 哈希核实能力。没有把绘世的「使用共享显存」映射成智能显存或 mmap，也没有修改驱动、注册表或绘世文件。

本轮没有启动真实 ComfyUI、执行推理、安装 Python 依赖或更新用户插件。外部 MCP 客户端与真实付费 API 未新增验收。旧管理器的快照仍不是完整 Python 环境备份，详见 [管理边界](workbench-drawing-manager.md)。

审查期间，临时脚本初版把 `E:/…` 直接写为 ESM import 地址，曾触发主进程报错弹窗。错误只在临时审查脚本，已改为文件 URL 并结束该测试进程；原正式工作台保持运行。最终包的四套 GUI 验收均正常退出。
