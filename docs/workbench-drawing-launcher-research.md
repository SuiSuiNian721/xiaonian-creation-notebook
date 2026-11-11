# 本机绘世功能与工作台实现范围

检查日期：2026-11-06。对象：`E:\ai draw\ComfyUI-aki-v2\.launcher`，绘世文件版本 `2.9.2.419`，产品版本 `1.0.0+e302a7fa74cc41f40fb927af1c09a9ebc5e98873`。本轮范围由念念选定为 P1＋P2。

## 证据层次

直接读取正在运行的绘世窗口可访问树，确认存在“一键启动”“高级选项”“版本管理”“控制台”“设置”“生成诊断包”入口。未点击启动、升级、修复或安装操作。

程序集符号、依赖文件和配置键能支持功能研究，不能证明某个内部调用链或边界行为。没有还原方法体，也没有复制绘世实现。配置仅提取字段名称，未采集服务地址、令牌或私人参数。`data.json` 含 JSON 之后的尾部字节，普通完整 JSON 解析会失败；研究脚本仅解析独立 JSON 前缀，未修改原文件。

完整只读证据保存在本机 `qa/drawing-manager/launcher-inspection.json`，脚本为同目录 `inspect-launcher.ps1`。以下“工作台实现”指本轮设计及实现目标，实际验证以交付验证记录为准。

| 用户看到的功能 | 本机证据 | 实现机制或仍待核实之处 | 实用程度 | 工作台实现与成本 |
| --- | --- | --- | --- | --- |
| 一键启动、高级参数 | 可访问树入口；`preference.json` 存在 `args`、`expert_settings` 键 | 启动 Python 子进程并构造参数是可验证方案；绘世确切参数生成逻辑未还原 | P1，高 | 参数数组、实际命令预览、独立保存与启动，成本中 |
| 控制台与启动失败排查 | 可访问树“控制台”；`Microsoft.Terminal.Control.dll` | 依赖支持终端界面，不能据此断言全部输出采集细节 | P1，高 | stdout/stderr 写入日志并显示限长尾部、PID 与退出结果，成本低至中 |
| 环境管理与诊断 | “生成诊断包”；`EnvironmentSettingsGroup`、`InstallPytorchCommand`、`RunPipAsync` 等符号；30 项 Torch 版本数据 | 可确认相关 UI/数据/符号存在，诊断包内容与安装事务规则尚未实测 | P1，高 | Python/Torch/CUDA、pip 一致性、磁盘主动探针，不自动修复，成本中 |
| 缺失节点与模型报告 | `ExtensionManagement_OnInitialized` 等符号；绘世是否提供完整工作流预检尚未证实 | 工作台直接使用 ComfyUI 的 `/object_info` 和实际枚举，比解析启动器配置更可靠 | P1，高 | 导入前按节点 ID 聚合缺项；复杂普通工作流明确未核实项，成本中 |
| 模型与插件管理 | `DownloadModel`、`ExtensionManagement_OnInitialized`、`FixExtensionBranchCommand`；LibGit2Sharp 依赖 | Git 来源/提交可通过独立 Git 读取；不能由依赖存在推断绘世更新或回退策略 | P2，高 | 只读模型索引，插件来源/提交/修改状态，主动安装/启用/禁用/更新，成本中至高 |
| 大文件下载 | `DownloadAsync`、`DownloadBatchAsync`、`DownloadFileWithRetry`；`aria2c.exe` | 下载能力有符号依据；是否对每种下载启用断点续传与完整性校验未证实 | P2，高 | 工作台独立流式下载，部分文件隔离、Range 恢复、预期 SHA256 校验与空间检查，成本高 |
| 版本管理与快照 | “版本管理”；`stable_versions`、`branches` 数据；Git 依赖 | 版本管理入口直接可见；完整 Python 环境快照/回退机制未证实 | P2，高 | Git/配置可恢复备份、依赖清单、更新前快照、恢复前差异计划，成本高 |
| 镜像与网络选择 | `mirrors`、`network_preference`、`ProxyGit`、`ProxyPip`、`TestPipIndex` | 能确认配置与符号；路由选择和测速算法未还原 | P3，本轮范围之外 | 保留直链来源与失败原因，不新增镜像代理管理 |

## 对实现的约束

工作台继续检测 ComfyUI 本体，不读取绘世偏好作为工作台配置。环境诊断和版本操作复用指定 ComfyUI 的 Python/Git，不安装第二套 ComfyUI。打开模块、查看清单与保存设置均不自动启动、下载或调用 AI。

ComfyUI 官方文档列出的 `/object_info`、`/models`、`/system_stats` 为工作流与服务检查依据；当前本机参数以本体的 `comfy/cli_args.py` 为准。ComfyUI-Manager 的快照设计可供比较，但工作台的快照会明确区分 Git/配置恢复与 Python 依赖清单，避免让用户误以为导出版本号就等于备份环境。

资料：[ComfyUI 服务接口](https://docs.comfy.org/development/comfyui-server/comms_routes)、[ComfyUI 启动参数源码](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/cli_args.py)、[ComfyUI-Manager 官方仓库](https://github.com/Comfy-Org/ComfyUI-Manager)。本轮没有确认绘世整体开源或复用许可证，所有新增程序均在工作台内独立实现。
