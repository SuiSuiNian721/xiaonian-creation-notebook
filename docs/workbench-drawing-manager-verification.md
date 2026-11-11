# ComfyUI 管理 0.6.0 验证与交付

日期：2026-11-06。范围：念念确认的 P1＋P2。源码保留在 `feat/drawing-manager-p1-p2`，基线 `7b9dd88`，未合入 main。功能说明见 [运行与资源管理](workbench-drawing-manager.md)，本机绘世研究见 [功能清单](workbench-drawing-launcher-research.md)。

## 可打开的版本

- 统一入口：`E:\智能，生命。\AI-未来工作台\打开 AI-未来工作台.lnk`，已回读确认指向本分支 `打开工作台.cmd`。
- 候选 EXE：`E:\智能，生命。\AI-未来工作台\分支\ai-future-drawing-manager\dist-workbench-next\win-unpacked\AI未来 工作台.exe`。
- 工作台版本 0.6.0，Electron 44.4.5；构建源提交 `2ef550e2db9d82c12e265ddbca6287cf9c83db26`，构建时工作区干净。
- `dist-workbench-next/build-record.json` 与包内 `resources/app/build-record.json` 记录源码提交、分支和 **61 个核心文件 SHA256**；构建器逐字节核对通过。
- 主项目旧包和当前窗口保留。关闭旧窗口后再打开统一入口，才会进入新版。升级前快捷方式与目录说明备份在分类根目录 `备份/绘图管理升级前入口-20261106-141103`。

正式资料继续位于 `%APPDATA%\AI-Future-Workbench`；本轮未迁移资料、未把既有模型移入工作台。程序与源码位于 E 盘，Windows 默认的正式运行资料仍在 C 盘。候选 EXE 验收使用独立 profile/data，未读取正式工作台的角色、对话或密钥。

## 自动与界面验证

| 层次 | 结果 | 本工作区证据 |
| --- | --- | --- |
| 初始基线 | 163/163，0 跳过 | `qa/drawing-manager/baseline.log` |
| 完整 Node 回归 | **241/241，0 失败、0 跳过** | `qa/drawing-manager/tests-release.log` |
| 下载专项 | 19/19，真实 C/E 跨盘发布 | `qa/drawing-manager/downloads-final.log` |
| P1 运行/工作流/公共 AI 相关回归 | 51/51，真实 Python 纯转换 | 测试文件 `drawing-runtime`、`drawing-workflows`、`drawing`、`shared-ai` |
| P2 管理器 | 31 项全部纳入完整回归；最终独立质量定向 11/11 | `tests/drawing-manager.test.mjs` |
| 最终包：管理页 GUI | **7 组通过，错误列表为空** | `qa/drawing-manager/packaged-final-manager/result.json` |
| 最终包：原绘图 GUI | **9 组通过，错误列表为空** | `qa/drawing-manager/packaged-final-drawing/result.json` |
| 最终包：工作台 GUI | **32 组通过，错误列表为空** | `qa/drawing-manager/packaged-final-workbench/result.json` |
| 最终包原生关闭 | 关闭前草稿实际落盘 | `qa/drawing-manager/packaged-final-workbench/lifecycle-result.json` |
| 随包 MC 运行端 | 依赖与隔离执行器自检通过 | `qa/drawing-manager/package-final.log` |

完整 Node 回归之后，仅调整深色选中按钮的文字颜色和对应 GUI 对比度断言；最终包三组 GUI 已重新执行。深色选中按钮文字对比度约 7.20:1。源码与包内代码核对、JS/PowerShell 语法、UTF-8 无 BOM、乱码及 `git diff --check` 均通过。

GUI 由最终 EXE 启动，覆盖设置保存不启动、命令预览、诊断异常、表单草稿、下载暂停与 Range 继续、SHA256 成功/失败、插件停用、操作前快照、恢复差异、手工快照、离页异步结果、轮询期间展开记录和键盘焦点、浅深色、125% 缩放及 390px 窗口。原绘图回归同时覆盖本体检测、参考图上传、任务与图片归档、公共 AI 候选及 MCP 设置。

测试使用真实临时文件、临时 Git 仓库、本地 HTTP 服务与协议夹具。Python 安装、ComfyUI 启动和 AI 回答在 GUI/管理器测试中注入替身；不把这些结果当作真实模型推理或真实 pip 安装证明。

## 资料与并发保护

独立需求和代码审查中确认的问题均已修复并回归：

- 配置变更不混用旧连接 schema；普通子图容器正确展开，并限制总访问预算。
- 下载只在校验后发布，目标文件不覆盖；C 盘资料目录到 E 盘模型目录的发布实际通过。
- 插件在目标盘隐藏 `.disabled` 暂存目录内克隆，确认提交后同卷发布；失败不启用残缺目录。
- Git 更新/切换/恢复不覆盖被忽略的用户文件；本体恢复逐文件确认插件内容已被快照 Git 保存。
- ComfyUI 启动探测与环境维护互斥；手动快照与应用操作双向互斥。
- 快照创建中切换配置会拒绝保存；恢复期间新改的环境或运行设置不会被旧快照覆盖，任务明确报告可能已经部分恢复。
- 页面请求离开后不改写新页面；未保存的运行设置保持启动按钮禁用；下载状态转换保留行内键盘焦点。

## 本机只读检查

证据：`qa/drawing-manager/local-readonly.json`，为本轮检查时的结果：

- 本体：`E:\ai draw\ComfyUI-aki-v2\ComfyUI`，0.42.0。
- Python：3.12.10；Torch：2.11.0+cu130；CUDA 可用；`pip check` 返回 `No broken requirements found.`。
- 索引 150 个模型文件、46 项本体/插件记录。部分仓库有本地改动，因此会拒绝直接更新或恢复。
- 外部 `extra_model_paths.yaml` 路径未纳入索引；一处模型目录联接被跳过并返回提示。

本轮没有启动真实 ComfyUI、提交真实绘图、下载大型模型、更新用户插件、本体或 Python 依赖。原有真实生成记录仍属于之前的验收。

## 使用边界

快照保存 Git 版本、启用状态、运行设置、两项选定配置文件和 Python 依赖清单；**不是完整 Python 环境备份**。模型及非 Git 插件的完整内容不复制。恢复不是跨仓库原子事务，中断或配置冲突应查看日志和恢复前快照。失败安装保留停用暂存目录，位置写入任务记录。

Git 操作使用本机 Git；生产来源接受不含凭据与查询参数的 HTTP(S) URL。外部模型目录未展开索引。公共 AI/MCP 沿用原有入口，本轮没有真实付费兼容 API 或外部 MCP 客户端新增验收。
