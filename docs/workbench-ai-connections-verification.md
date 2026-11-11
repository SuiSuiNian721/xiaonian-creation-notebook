# AI 接入 0.8.0 验证

2026-11-06，按念念确认的逐项继承规则与右上角小入口完成：全部九个模块共用「AI 接入」按钮及浮层，正文不放大表单。填写的字段覆盖当前模块，空字段动态继承全局。来源、模型、档位、地址、启用状态与认证由公共调用层统一解析。

密钥支持继承、独立填写和不使用密钥；连接失败不切换服务。来源恢复全局后保留已保存覆盖与当前会话草稿，过期保存响应不会复活旧来源。角色卡编辑器原接入按钮也打开同一个模块浮层。使用说明见 [AI 接入](workbench-ai-connections.md)。

## 源码与程序包

- 工作分支：`feat/module-ai-connections`，保留工作区，未合入 main。
- 构建源：`8ee67041de4fee08833440e29dc6f37399bd89ff`，构建时工作区干净。
- 输出：`dist-workbench-connections/win-unpacked/AI未来 工作台.exe`，版本 `0.8.0`。
- 包内 72 项核心文件 SHA256 与构建记录、当前源码逐字节一致；9 模块与包版本一致。新增核心文件含连接解析、桥接隔离和公共浮层入口。
- 打包后的 AIRI Minecraft 依赖与隔离执行器自检通过。内置小汐源码快照及其来源清单保持原样。
- 汇总证据：`dist-workbench-connections/release-verification.json` 与 `qa/bridge-check/release-final.json`。

## 验证结果

| 范围 | 结果 | 证据（相对本工作区） |
| --- | --- | --- |
| 主回归 | 287 项，283 通过、0 失败、4 项 Python 条件跳过 | `qa/bridge-check/tests-full.log` |
| 真实 Python 补跑 | 53/53，包含上述全部 4 个跳过项，0 跳过 | `qa/bridge-check/python-regression.log` |
| 编辑器接入适配最终回归 | 16/16，含资源完整性与草稿持久化 | `qa/bridge-check/card-embed-regression.log` |
| 源码浮层与绘图 GUI | 13 组通过，无页面错误 | `qa/bridge-check/stale-save-green/result.json` |
| 最终 EXE 浮层与绘图 | 13 组通过，无页面错误 | `qa/bridge-check/packaged-drawing/result.json` |
| 最终 EXE 启动器 | 12 组通过，无页面错误 | `qa/bridge-check/packaged-launcher/result.json` |
| 最终 EXE 工作台与角色卡 | 32 组通过，无页面错误 | `qa/bridge-check/packaged-workbench/result.json` |
| 最终 EXE 原生关闭 | 聊天草稿在关闭前实际落盘 | `qa/bridge-check/packaged-workbench/lifecycle-result.json` |
| 包内默认桥接真实调用 | 返回 `OK`，12.155 秒，全局 Codex 配置文件 SHA256 不变 | `qa/bridge-check/packaged-live/result.json` |
| 原入口选择 | 回读选择 0.8.0，未启动正式用户窗口 | `qa/bridge-check/entry-verification.json` |

实际查看了最终 EXE 的浅色桌面与深色 390px 浮层截图。所有模块的按钮、浮层保存、作用域 ID 和参数路由通过；390px、125%／200% 缩放无横向溢出，浮层不越界，Esc 关闭返回按钮焦点，关闭重开保留字段草稿。

GUI 回归刻意延迟保存响应，覆盖“旧浮层关闭、新浮层完成保存、旧响应才返回”的顺序，已确认旧来源不会覆盖最新保存。测试期间保留新输入并阻止提交另一套配置，不将旧测试结果当成新配置成功。关闭验收在输入框确认可输入后立即写入并关闭，避免向尚未绑定对话的禁用控件注入内容。

JavaScript／PowerShell 语法、UTF-8 无 BOM、常见乱码与 `git diff --check` 均通过。结构化记录通过 JSON 解析和字段断言核对。

## 桥接耗时

原运行程序的 `/api/ai/test` 用时 120.179 秒。相同已安装 CLI、`gpt-6.1-sol` 与 `xhigh`，源码修复后实测 9.068 秒；最终包内后端使用默认 Codex runner 实测 12.155 秒。测试完整经过认证检查、线程、模型回复和进程收尾。

修复先读取配置中的 MCP 名称，再向本次生成子进程传入禁用这些服务的 TOML 内联表，避免额外工具的 120 秒启动等待。未降低模型或档位，外部绘图 MCP 继续可用；CLI 内置 `codex_apps` 仍可能启动。配置读取通过 [官方 App Server 协议](https://developers.openai.com/codex/app-server) 实现，未写入全局配置。上述是本机本次耗时，网络和模型内容仍会影响响应速度。

## 入口与范围

统一入口仍为分类根目录的 `打开 AI-未来工作台.lnk`，启动脚本现优先选择 0.8.0。升级前快捷方式、分类说明和启动脚本保存在 `备份/AI接入升级前入口-20261106-212601`；0.7.1、0.7.0 和 0.6.0 输出保留。正式连接参数和角色资料未迁移，当前用户窗口未被强制关闭，关闭后从原入口重开生效。

GUI 的模型调用、ComfyUI 协议与资源安装使用隔离夹具；真实 Codex 验证是一条 `OK` 请求。第三方 API、真实 ComfyUI 推理和 Minecraft 世界未在本轮实连验收。尚未实现的模块只增加统一接入配置入口，业务能力仍以各模块页面为准。
