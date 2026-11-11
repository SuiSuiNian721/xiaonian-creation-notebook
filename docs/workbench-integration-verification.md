# 工作台整合与 main 合入验证

记录日期：2026-11-06（北京时间）。桌面版本 0.5.0。

本轮整合角色卡与共用 AI、ComfyUI 绘图、MC 皮肤、AIRI MC 陪玩。LoRA 训练、角色声音、虚拟陪伴和 QQ 仍保留原有计划状态，不属于本轮已经实现的功能。

## 来源与保留

- 原主目录：`E:\AI-未来\ai-future-demo`，基础提交 `2b52967`。
- 绘图目录：`E:\AI-未来\ai-future-comfyui`，已交付提交 `290a323`，另纳入其 10 个文件的后续修改，包括通用 ComfyUI 目录检测和虚拟环境优先选择。
- 隔离整合目录：`E:\AI-未来\ai-future-integration`。全部验证在此目录进行。
- 原始源码和未提交状态快照：`E:\AI-未来\backups\workbench-pre-main-20261106`。两个源目录均在整合期间按文件哈希检查，没有发现继续变动或遗漏的新文件。

保留绘图提交的历史，在此基础上纳入 MC 模块和后续修复。8 处文本合并冲突核对为 CRLF/LF 差异；共享服务器和模块注册表保留双方功能。新增第三方来源目录采用逐字节 Git 属性，保持清单哈希；Node 原始许可证中的空白保持原样。

## 本轮实际验证

证据目录：`E:\AI-未来\ai-future-integration\qa\integration`。以下均在本轮重新执行。

| 检查 | 结果 | 证据文件 |
| --- | --- | --- |
| 合入前绘图基线 | 130/130 通过 | `baseline-tests.log` |
| 最终 Node 全量回归 | 163/163 通过 | `tests-final.log` |
| 皮肤 Python 适配器 | 13/13 通过 | `python-adapter.log` |
| 像素 Skill 原用例 | 16/16 通过 | `python-skill.log` |
| 源码工作台回归 | 32 组通过，界面错误为空 | `workbench-source/result.json` |
| 源码绘图 / 皮肤 / 陪玩 | 9 / 14 / 5 组通过 | 对应 `*-source/result.json` |
| 最终 Windows 包构建 | 退出码 0，包内 AIRI 原生隔离规划器自检通过 | `package-final.log` |
| 实际打包 EXE 工作台回归 | 32 组通过，界面错误为空 | `workbench-packaged/result.json` |
| 打包 EXE 原生关闭及草稿落盘 | 通过 | `workbench-packaged/lifecycle-result.json` |
| 包内绘图 / 皮肤 / 陪玩 | 9 / 14 / 5 组通过，界面错误为空 | 对应 `*-packaged/result.json` |
| 普通 EXE 启动及正常关闭 | 隔离资料目录通过，三个模块版本正确 | `normal-start.json` |
| 第三方来源与编码 | AIRI 160 项、皮肤 Skill 27 项哈希一致；无乱码或合并标记 | `source-audit.json` |
| 合入前独立代码审查 | 两项 P2 修复后复核可合入 | 下节回归证据 |

正常启动检查确认 AIRI 运行环境和 Python/Pillow 可用；打开 MC 模块仍保持未连接，自动 Minecraft 子进程数为 0。正式用户资料未被 QA 修改。

## 审查发现与修复

1. MC 暂停、断开或内部 HTTP 请求关闭后，宿主中的共用模型请求原先可能继续运行到完成或超时。现在请求级取消信号传递给 SharedAI；退出、掉线、失败和暂停均取消相关请求，恢复后不接受已取消请求的旧回复。没有将此问题扩大表述为已证实游戏执行旧动作。
2. 皮肤提交若在关闭时等待环境或目录检查，原先仍可能迟到入队。现在入口和关键异步检查后都检查关闭状态，运行端关闭后不再返回可用缓存或启动新 Python。

修复前失败证据为 `lifecycle-red.log` 和 `http-cancel-red.log`。同路径修复后通过，两个 MC 模块全套 28 项通过，随后再次运行全部 163 项测试并重新构建、验证桌面包。

## 运行包与验收边界

本轮验证包：`E:\AI-未来\ai-future-integration\dist-workbench\win-unpacked\AI未来 工作台.exe`。对应入口为该整合目录的 `打开工作台.cmd`。当前正在使用的旧程序未被强制退出或覆盖；运行新版前需正常退出旧窗口，避免单实例机制回到旧程序。

ComfyUI、模型和 Minecraft 上游在本轮 GUI 检查中采用隔离协议夹具，皮肤实际运行 Python 和 WebGL，MC 实际运行 Mineflayer 与 AIRI 并发送游戏协议聊天包。此前真实 ComfyUI/Codex 调用的记录分别保留于各模块交付文档，本轮未重复调用真实付费模型或生成图片。

尚未验证念念自己的 Minecraft 世界、微软账号登录、长时间自主陪玩和整合包兼容性；皮肤的游戏内效果也尚未验证。测试通过证明上述代码及已列流程可运行，不代表所有外部环境已经验收。
