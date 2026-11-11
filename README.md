# 小念的创作笔记

一个 Windows 桌面 AI 创作工作台，将角色资料、角色卡、绘图、声音、LoRA 训练、虚拟陪伴、QQ 对话和 Minecraft 工具放在同一个应用中。

**[下载 Windows app](https://github.com/SuiSuiNian721/xiaonian-creation-notebook/releases/latest)** · [使用说明](WORKBENCH.md) · [许可范围](LICENSING.md)

> 允许非商业使用、修改和二次创作；必须署名念念（SuiSuiNian721）并保留项目链接，禁止一切商业用途。原创部分适用 [LICENSE](LICENSE)，第三方内容保留原许可证。本项目属于源码公开的非商业软件。

## 可以做什么

- **角色资料与角色卡**：保存人设、世界书、记忆和素材，编辑、导入与导出角色卡。
- **绘图与 ComfyUI**：配置运行环境、选择工作流、管理输入与结果，使用 AI 辅助创作。
- **声音**：声音设计、参考音频克隆与音色管理，按需准备本机模型和运行环境。
- **LoRA 训练**：通过可选 Next Trainer 组件管理参数、预检、任务与日志。
- **虚拟陪伴和 QQ**：各实例分别保存角色、接入设置与会话；QQ 运行端按需准备。
- **Minecraft**：制作和预览皮肤，同时运行多个陪玩 Bot，为每个 Bot 设置独立 PNG 皮肤。局域网世界的皮肤同步需要房主侧安装兼容的 SkinRestorer。

## 安装与运行

1. 在 [Releases](https://github.com/SuiSuiNian721/xiaonian-creation-notebook/releases) 下载 Windows x64 ZIP，完整解压。
2. 运行 `win-unpacked\小念的创作笔记.exe`。请保留整个目录，不能只复制 EXE。
3. 在「添加模块」中选择要使用的工具，配置自己的 AI 接入和本机环境。

ZIP 同级的 `components` 目录包含匹配版本的 MC 陪玩、训练离线组件；在对应模块点击「安装组件」，或选择「导入本机包」。组件、Python/CUDA、ComfyUI、模型权重和 QQ 网关不是同一类资源，具体要求以模块检查结果为准。

应用包不包含开发者的聊天、账号、角色库、接入密钥或模型权重。正式 app 默认资料目录为 `%APPDATA%\AI-Future-Workbench`；升级前可自行备份此目录。API 和模型服务会按你的配置接收提交的内容。

当前发布为 Windows x64。应用未配置 Authenticode 数字签名；文件校验值随 Release 提供。

## 从源码启动

需要 Node.js 24.13 或更新的兼容版本，Windows 命令使用 PowerShell 7。

```powershell
git clone https://github.com/SuiSuiNian721/xiaonian-creation-notebook.git
Set-Location -LiteralPath '.\xiaonian-creation-notebook'
npm ci
npm install --no-save --package-lock=false electron@44.4.5 electron-builder@26.15.3
$env:AI_FUTURE_ELECTRON = Join-Path (Get-Location) 'node_modules\electron\dist\electron.exe'
$env:AI_FUTURE_BUILD_TOOLS = (Get-Location).Path
npm run workbench
```

仅启动本机 HTTP 服务可使用 `npm run workbench:server`。开发验证请设置独立的 `AI_FUTURE_WORKBENCH_PROFILE_DIR`，避免与日常资料共用。

## 构建与验证

首次构建可直接使用 Release 中与本版本配套的 `components/catalog.json` 和 `.afcomponent` 文件：

```powershell
$env:AI_FUTURE_COMPONENT_CATALOG = '<已解压发行包>\components\catalog.json'
$env:AI_FUTURE_BUILD_TOOLS = (Get-Location).Path
npm run package:workbench
```

输出位于 `dist-workbench-release\win-unpacked`。分发时将同版 `components` 放在其同级目录。若修改 MC 运行端，应先在 `integrations\airi-minecraft` 执行 `npm ci` 并准备匹配 Node 运行时，再通过 `node tools/package-components.mjs` 重建组件；不要把旧组件作为修改版的运行端。

```powershell
node --test --test-concurrency=4 tests/*.test.mjs
npm run qa:workbench
```

部分测试需要 Electron、独立组件或本机可选环境。首次公开版本的成品 EXE 专项检查、旧全页面脚本的已知限制见 [发布说明](docs/releases/2026-11-12.md)；不把源码检查等同于真实 AI、训练、QQ 或游戏验证。

## 二次创作与署名

可以非商业地 fork、修改、翻译和再发布；保留 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和全部第三方声明，并在仓库首页、随附说明或应用“关于”页提供清晰署名，例如：

> 基于《小念的创作笔记》，原作者：念念（SuiSuiNian721）。  
> 原项目：https://github.com/SuiSuiNian721/xiaonian-creation-notebook  
> 本版本由〈修改者〉修改，主要修改：〈内容〉。

禁止出售、收费部署、付费服务、广告或订阅变现、企业商业内部使用及其他商业用途。完整适用范围以许可证为准；第三方组件按各自原许可证处理。提交贡献表示你有权提供该贡献，并同意其遵守所在部分的许可证。
