# 授权范围

本项目公开源码，允许非商业二次创作，要求署名，禁止一切商业用途。原创部分的完整条件见 [LICENSE](LICENSE)，再发布署名格式见 [NOTICE](NOTICE)。这是 **source-available（源码可用）授权**，不是 OSI 定义的开源许可证。

## 原创部分

除文件自身、所在组件或下表另有许可说明外，工作台的原创代码、文档和原创资源适用根目录许可证。再发布原版或修改版时，保留许可证和署名，标明修改，不得以出售、收费服务、商业内部部署、商业内容制作等形式使用。

## 第三方内容

根目录许可证不覆盖或限制第三方已经授予的权利。单独提取、修改、使用和分发第三方组件时，以其原许可证为准；把它们与本项目原创部分一起分发，也不能省略各自声明。

| 内容 | 许可证与位置 |
| --- | --- |
| AIRI Minecraft 及该组件内适配代码 | `integrations/airi-minecraft/package.json` 声明 MIT；完整 AIRI 许可见 `LICENSE.AIRI`，独立 Node 见 `LICENSE.Node`，依赖按锁文件及各自声明 |
| Next Trainer 修改版源码 | `integrations/next-trainer/source/LICENSE` 的 AGPL-3.0；修改后的对应源码已完整保留，内含子组件保留各自许可证 |
| sd-scripts 等训练组件 | 各自目录的 `LICENSE.md`，不得按工作台禁商用条款重新许可 |
| ComfyUI 工作流转换程序 | `integrations/comfy/LICENSE` 的 GPL-3.0；作为独立 Python 程序调用，源码随附 |
| DS 鲸鱼娘 | CC BY-NC-SA 4.0 及原作者使用说明；见 `resources/companion/ds-whale/使用须知.txt`，原文件完整保留 |
| 表情文字知识目录 | CC BY-NC 4.0；见 `resources/media` 的许可、NOTICE 与来源记录 |
| skinview3d、二维码及字体 | 对应 vendor / fonts 目录内许可 |
| Electron、Chromium、Node 与 npm 依赖 | 运行目录及各依赖中的原始 LICENSE / NOTICE |

上述列表用于导航；完整署名、来源、版本及其他组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。上游许可证允许商用的第三方组件，不会因为与本项目同仓而失去该权利；本项目的原创部分和完整应用仍须遵守根目录的非商业条件。

训练源码和 ComfyUI 转换程序按各自许可证独立分发与运行。针对它们的修改仍遵守原许可证；本项目没有将 GPL/AGPL 覆盖的代码改成禁商用许可。分发方式发生改变时，需重新核对组合方式及相应源码义务。

模型权重、第三方服务和游戏本体不由本项目统一授权。使用应用生成内容并不会自动取得素材、声音、人物或模型的第三方权利。
