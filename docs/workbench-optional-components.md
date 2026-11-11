# 按需组件与存储

0.11.0 将 MC 陪玩运行端和训练内核移出基础包。模块页面和适配接口保留在工作台内，首次使用时安装相应组件；打开首页或其他模块不会下载它们。

## 使用

- 在 MC 陪玩或训练页面点击「导入本机包」，选择本次发布的 `.afcomponent` 文件。也可以把同一发行版的两个组件包放在 `win-unpacked` 的同级 `components` 目录，点击「安装组件」。
- 「工作台设置 → 组件与存储」管理共享安装、下载缓存与受管资源。组件在同一资料目录的所有实例之间共用。
- 「组件下载源」可配置 HTTPS 目录或本机 HTTP 目录。目录直接提供发行清单中对应文件名的组件包；本版本未配置公共下载站点。
- 当前发行清单固定组件的平台、架构、版本、长度与 SHA256。导入其他版本或损坏的文件会失败，原安装保持可用。
- 可取消下载；已有有效分片在重试时继续使用。安装使用暂存目录，完整校验后才切换；中断的暂存与不再引用的旧版本可以通过「清理缓存」回收。

## 保留与复用

源码目录已有的 MC 环境、训练快照，以及现有 Python、CUDA、ComfyUI、模型路径继续复用。MC 组件自带匹配的 Node；训练组件包含训练内核，但 Python/CUDA 与模型仍从已配置环境接入。

卸载只处理带可验证所有权记录的文件，并在执行前显示范围与空间。正在使用的组件不能卸载；后台训练进程仍存活时，其引用跨工作台重启保留。角色、聊天、密钥、音色、参考音频、训练图集、预设和输出不属于组件文件。

新安装的 MOSS 模型、Qwen 模型、视觉扩展和 QQ 运行端登记独立资源；相关下载分片和受管 UV 缓存可回收。旧安装、用户指定的外部环境、完整 Python 环境本体，以及出现未知文件或链接的目录保留为只读，不自动接管或删除。ComfyUI 环境继续通过原环境管理界面维护。

## 构建和验收

在项目根目录用 Node 24.13 或更新版本运行：

```powershell
node tools/package-components.mjs
node tools/verify-component-release.mjs
$env:AI_FUTURE_COMPONENT_CATALOG = (Resolve-Path -LiteralPath 'artifacts\optional-components\catalog.json').Path
$env:AI_FUTURE_PACKAGE_OUTPUT = 'dist-workbench-release'
node tools/package-workbench.mjs
```

组件发布器从当前本机已准备的 MC 依赖和训练快照生成归档，并实际提取、自检后发布 catalog。验收脚本强制通过本机 HTTP 下载真实组件，使用隔离资料目录验证安装、双实例复用、使用中拒绝卸载、释放后卸载与缓存回收，并核对角色和训练输出保留。

基础包构建对包内源码逐项校验 SHA256，拒绝混入 MC、训练快照、独立 Node、组件归档或模型权重，并执行 450 MiB 展开体积上限。Electron 系统界面语言包只保留简体中文与英文，Unicode 文本和多语言角色内容仍由完整 ICU 支持。实测文件清单在构建目录 `package-files.json`；组件验收结果在 `artifacts/optional-components-validation/report.json`。这不替代真实游戏联机、GPU 训练或生成质量验收。
