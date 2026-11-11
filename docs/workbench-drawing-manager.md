# ComfyUI 运行与资源管理

工作台 0.6.0 将已有 ComfyUI 接入扩展为运行环境、模型/插件、下载与快照管理。继续使用同一份公共 AI / MCP 配置，完整节点画布仍在原生 ComfyUI 中打开。工作台检测本体，不读取绘世启动器的个人配置。

0.7.0 已将启动与维护移到独立的「ComfyUI 启动器」，工作流与出图留在「角色绘图」。高级参数、共享配置和升级方式见 [启动器说明](workbench-comfyui-launcher.md)。以下管理机制继续沿用。

## 使用入口

在「ComfyUI 启动器 → 环境配置」保存本体目录与本机服务地址，再按需要操作：

- **启动**：指定 Python 与分组运行参数。保存不启动；启动命令、工作台启动日志、PID 与退出状态可查看。「检查环境」主动检查 Python、ComfyUI、Torch/CUDA、CLI 参数、可选依赖、磁盘及 `pip check`，不安装依赖或加载模型。
- **角色绘图 → 工作流与 MCP**：导入文件、本地扫描导入和采用 AI 候选前预检。缺失节点、模型枚举、参数问题按节点集中显示。断线不复用旧 schema 作为当前证据；无法确认的普通工作流控件保持未核实。
- **模型与插件 → 模型**：「重新索引」读取本体 `models`，可搜索类别/名称、查看大小、路径和已记录来源。当前不展开 `extra_model_paths.yaml` 的外部目录，也跳过目录联接，并在索引提示中说明。
- **插件与本体**：查看 Git 来源、分支、提交、修改状态和启停状态。可按 HTTP(S) Git URL 安装插件，或管理已索引仓库。预览计划后明确应用；浏览和预览不安装依赖。指定版本支持公开远端分支、标签及其完整 SHA；留空只对当前分支快进更新。
- **下载**：填写模型 HTTP(S) 直链、类别、文件名及可选 SHA256。支持暂停/继续、Range 恢复与空间检查。未提供预期 SHA256 时只记录本地哈希；下载、校验完成后才发布，已有文件不覆盖。
- **快照**：手动创建或导出；所有环境修改前也自动创建。恢复先展示差异，应用前再创建一份快照。后台管理任务和日志可查看，关闭工作台会停止自己的下载与维护任务，重启后不会自动重做。

## 更新与恢复的边界

更新、恢复、启停、安装依赖前需退出 ComfyUI。工作台会检查本地服务、已记录 PID 和正在进行的启动；工作台启动与环境维护互斥。计划固定目录、来源与版本，配置或仓库状态变化时需要重新预览。

Git 脏仓库拒绝更新/恢复，不执行全局 `reset` 或 `clean`。Git 忽略的本地设置同样受保护，切换版本不能覆盖这些文件。显式版本切到分离 HEAD，保留原分支；恢复需要移动已前进分支时，先建立备份分支。源已发生分叉时，默认快进更新会失败并保留本地内容。

快照保存：

- 本体与插件的 Git 提交、分支、状态及启用状态。
- 工作台运行设置。
- `extra_model_paths.yaml`、`user/default/comfy.settings.json` 的原始字节与 SHA256（存在时）。
- 指定 Python 的版本和 `pip freeze` 清单。

**Python 依赖清单不是完整环境备份，不能自动回退 Python 包。** 安装第三方依赖可能部分成功后失败，界面会明确提示。插件安装只克隆代码，不执行 `install.py`；有 `requirements.txt` 的插件可另行预览并确认依赖安装。

快照不复制模型或非 Git 插件的完整文件内容，也不删除后来新增的模型/插件。快照原本不存在的配置文件保持当前状态；缺失 Git 对象、配置备份校验失败、未提交改动或可能移除未备份插件资源的本体回退会拒绝执行。手动快照与环境维护互斥，创建期间更换配置会拒绝保存。恢复不是跨仓库原子事务；中断后应查看任务日志与恢复前快照，不把中断标记为成功。

下载任务固定最初提交的 ComfyUI 目录。部分文件在工作台私有目录中，跨盘时先复制到目标同卷的隐藏暂存文件，再以不覆盖方式发布。插件克隆暂存于目标 `custom_nodes` 下的独立隐藏 `.disabled` 目录，验证后同卷重命名；失败或中断不启用残缺目录，日志保留其位置。

## HTTP 接口

前缀：`/api/modules/drawing`。0.7.0 中，运行、连接和环境维护接口在 `drawing` 或 `comfyui` 任一入口启用时可用；工作流、生成、图片及绘图 MCP 工具仍要求启用 `drawing`。现有任务、图片、公共 AI 与 9 个 MCP 工具保持原行为；环境维护不暴露为自动执行的 MCP 工具。

| 方法 | 相对路径 | 用途 |
| --- | --- | --- |
| GET | `/runtime`、`/runtime/logs` | 运行设置、命令预览和日志 |
| POST | `/runtime/settings`、`/runtime/diagnose` | 保存设置或主动诊断 |
| POST | `/runtime/stop` | 仅停止当前工作台持有的 ComfyUI 子进程 |
| POST | `/workflows/inspect`、`/workflows/inspect-file` | JSON / 已扫描文件预检 |
| GET | `/manager/state` | 只读已存索引、下载、快照与任务记录 |
| POST | `/manager/inventory` | 主动索引本体模型与插件 |
| POST | `/manager/plan`、`/manager/apply` | 计划与应用（`planId`） |
| POST | `/manager/downloads` | 幂等创建下载（`requestId`） |
| POST | `/manager/downloads/{id}/pause`、`/resume` | 暂停与继续 |
| POST | `/manager/snapshots` | 创建快照 |
| GET | `/manager/snapshots/{id}` | 导出完整快照 |

管理操作为 `install-plugin`、`update`、`disable-plugin`、`enable-plugin`、`dependencies`、`restore`。任务详情在 `/manager/state` 中返回。维护记录、部分下载与快照保存在工作台独立资料目录的 `drawing` 下。

## 源码与交付

0.6.0 的 `feat/drawing-manager-p1-p2` 与 `dist-workbench-next` 保留。当前拆分源码位于 `feat/comfyui-launcher-workspace`，0.7.0 输出为 `dist-workbench-launcher`。构建器逐字节核对绘图/公共服务/UI/Comfy 转换器与包内入口，并将源码提交、分支、SHA256 写入 `build-record.json`。

验证结果和真实环境边界见 [本轮验证记录](workbench-drawing-manager-verification.md)。绘世的本机功能证据及实现选择见 [研究清单](workbench-drawing-launcher-research.md)。
