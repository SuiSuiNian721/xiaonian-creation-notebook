# 第三方组件与本地演示边界

## QQ 接入

QQ 模块按需下载并校验 NapNeko/NapCatQQ 4.18.42 的 Windows Node 运行包；QQ 本体、NapCat 运行包和账号票据不随工作台源码或应用包内置。NapCat 使用自定义 Limited Redistribution License，限制商业用途，来源与许可：https://github.com/NapNeko/NapCatQQ 。

二维码在本机使用 qrcode-generator 1.4.4（MIT）编码，源码与许可位于 `public-workbench/vendor`。QQ 模块不使用外部二维码生成网站；二维码和登录令牌不进入角色包与运行记录。

QQ 公开表情的文字知识目录来自 [Loping151/dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers)，固定提交 `b7b58c0ff347d639fabe87d90d6716c4b3cad185`，目录版本 `2026-10-23T10:02Z`。知识数据采用 CC BY-NC 4.0；作者为「可以叫我云大人／雾雪」，作者链接为 [Bilibili](https://space.bilibili.com/103739) 与 [kiriyuki.com](https://kiriyuki.com)。完整原许可、NOTICE 与来源记录位于 `resources/media`。随码只保存文字目录和资源清单；GIF 由 OneBot 按所选远程 URL 获取，不内置全库。GIF 保留原作者非商用分享条款，不因知识数据许可自动取得其他授权；大肥鱼和 GPT娘的设计来源详见原许可文件。

本 Demo 是独立的 AI-未来工作台，复用 AIRI 的形象渲染组件；不是 AIRI 官方发行版。角色会话、QQ 适配和管理功能由本项目提供。源码与运行数据分开，发布目录不得包含个人配置、登录态或聊天数据库。

## Aurora 界面参考

视觉参考：[micromimo/Auroraqua-UI](https://gitee.com/micromimo/Auroraqua-UI)，提交 `456e6e0e13ba26233bff30cade20a0bb889e28c0`。上游源码为 MPL-2.0。本次只参考其冰态果冻视觉风格，自行编写 `public-aurora` 的 HTML、样式和控制器，未复制上游组件源码、字体、头像或演示图片；参考仓库保存在开发 artifacts 中，不随程序打包。

## AIRI

上游：https://github.com/moeru-ai/airi

MIT License

Copyright (c) 2024-PRESENT Neko Ayaka

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## AIRI 虚拟陪伴运行端

虚拟陪伴 0.9.0 另以只读方式使用本机 AIRI 0.12.0-beta.5 的完整运行代码。兼容层位于 `desktop/companion-*` 和 `framework/companion*`，通过受限的模块加载钩子适配运行上下文与窗口，不覆盖原安装。该候选包不重新分发完整 AIRI 资源、Live2D SDK 或角色模型；这些组件保留原有授权边界。

## AIRI Minecraft 运行端

MC 陪玩复用 AIRI v0.15.1 的 `integrations/minecraft`，源提交 `89ec1e953f2e3b6f529d1f387d19bf5678ec6814`。源码、原始哈希和适配说明位于 `integrations/airi-minecraft`，原 MIT 许可完整保存在 `LICENSE.AIRI`。运行包的副本位于 `resources/airi-minecraft`。该组件不包含 Live2D SDK、角色模型、游戏客户端、游戏存档或任何登录缓存。

MC 运行端使用独立 Node.js 24.13.0；Node 及其所含组件的声明在 `LICENSE.Node`。Mineflayer、isolated-vm、tsx 和其他运行依赖由独立 `package-lock.json` 锁定，各自许可证随 `node_modules` 一起保留。

## Next Trainer 训练内核

LoRA 模块包含本机修改版 Next Trainer 3.3.1-dev 的源码快照，上游为 [wochenlong/lora-scripts-next](https://github.com/wochenlong/lora-scripts-next)，基于提交 `12963ec369f0c6dd0a0cff94aed6da39ec3929e2`。源码、原始 AGPL-3.0 许可、上游致谢与各组件许可完整保留在 `integrations/next-trainer/source`，逐文件来源与哈希记录在 `source-manifest.json`。本地修改保留 MOSS 配置识别、文本缓存修正、ETA 与硬件监控；工作台的进程入口和提交记录适配位于该目录外层及 `framework/training*.mjs`。

当前内置 Kohya / sd-scripts 训练源码，Python/CUDA 与已安装包通过用户选择的本机环境复用。未携带个人配置、训练历史、数据集、模型、权重或 Python 虚拟环境。其他未内置引擎不会在 APP 中自动安装。

## Electron 与 Chromium

Windows 运行目录保留运行时提供的 LICENSE、LICENSES.chromium.html。依赖许可证以各包实际版本为准。

## 角色模板与变量运行层

角色系统使用 quickjs-emscripten 0.32.0（MIT，含各自声明的 QuickJS/WASM 依赖）、EJS 7.0.2（Apache-2.0）、YAML 2.9.1（ISC）与 JSON5 2.2.3（MIT）。准确版本与完整传递依赖由根 `package-lock.json` 锁定，各包许可证随运行依赖保留。来源核对、上游机制参考及兼容边界记录在 `docs/character-life-sources.md`；本轮没有复制所参考机器人的人设、表情包或配置，也没有分发完整酒馆扩展。

## 小汐角色卡创作区

工作台按念念的要求整合本机 `F:/小汐的研究日志` 0.1.29 的工具代码及默认写作资源，副本位于 `integrations/xiaoxi`。`source-manifest.json` 记录112个来源文件、大小和 SHA256。原项目、个人作品、聊天、接入配置和上传资料不随本次整合复制。字体的许可说明保留在 `integrations/xiaoxi/assets/fonts`。

## 模型与素材

虚拟陪伴内置的 DS 鲸鱼娘来自用户提供的 `DS鲸鱼娘.zip`，采用鼠控版。模型制作：B站 @氵六青（11272072）；形象版权所有：@上善无形、@ZipZipPin。原包标注 CC BY-NC-SA 4.0，并注明禁止出售。完整原始使用说明保留在 `resources/companion/ds-whale/使用须知.txt` 及模型 ZIP 内；源包、变体和适配包的哈希保存在同目录 `source-manifest.json`。适配仅登记已有表情与动作的文件引用，不改动模型本体、纹理和物理文件。VTube Studio 的原按键表不表示工作台实现了对应快捷键或面捕功能。

应用图标由用户提供的 `小璃_快捷方式.ico` 导入，ICO 原字节保留于 `public-workbench/app.ico`，桌面运行端的 PNG 为同一图标的格式转换。该图标不会作为用户头像的默认值。

MC 皮肤模块按念念的要求整合本机 `F:/codex/skills/minecraft-pixel-skin` 的 Skill、脚本与两种冻结眼型模板，副本及27文件来源哈希位于 `integrations/minecraft-pixel-skin`。预览采用 skinview3d 3.4.2（https://github.com/bs-community/skinview3d），MIT 许可原文保留在 `assets/vendor/skinview3d-LICENSE.txt`。原 Skill 和个人皮肤资料不被修改；Python / Pillow 运行环境由本机提供。

绘图模块的独立 Python 工作流转换程序来自 Comfy-Org/comfy-cli 1.17.0 的 `workflow_to_api.py`，随附完整源码与 GPL-3.0 许可，位于 `integrations/comfy`。工作台通过标准输入输出调用此程序，复用已有 ComfyUI Python，不向原环境安装依赖。上游地址：https://github.com/Comfy-Org/comfy-cli 。

AIRI 的 MIT 许可不自动覆盖 Live2D Cubism Core、示例模型、字体、图标和其他第三方素材。首版供念念本机开发验证；对外发布需核对实际导出的组件、模型与 SDK 授权。现有私人人设、参考音频和 QQ 记录不随安装包分发。
