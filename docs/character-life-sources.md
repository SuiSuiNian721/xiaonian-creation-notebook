# 角色系统来源与兼容范围

核对日期：2026-11-07。以下项目作为公开机制、文件格式和接口资料；本轮未复制其人设、素材、配置或实现代码。分支 SHA 通过 `git ls-remote` 核对，README、文档和 LICENSE 通过上游页面核对。GitHub 未认证 tree API 被限流，因此不把未取得的完整目录树作为证据。

## 来源清单

| 来源、核对版本 | 参考能力和入口 | 许可证与采用方式 |
| --- | --- | --- |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127) release `06bde939fb1e9c4c8d8641d810f0a916b5bce127` | [角色字段](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)、[世界书](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)；JSON/PNG、描述/示例/开场、触发/递归/概率/深度 | [AGPL-3.0](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/LICENSE)。独立实现数据格式和编排，不嵌入整个宿主。 |
| [MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate/tree/d03b7dc8a6ebf9bd611c7e2dc91f3b35462deebc) beta `d03b7dc8a6ebf9bd611c7e2dc91f3b35462deebc` | [doc/tutorial.md](https://github.com/MagicalAstrogy/MagVarUpdate/blob/d03b7dc8a6ebf9bd611c7e2dc91f3b35462deebc/doc/tutorial.md)、`src/`、`artifact/`；InitVar、原生命令、变量事件 | [MIT](https://github.com/MagicalAstrogy/MagVarUpdate/blob/d03b7dc8a6ebf9bd611c7e2dc91f3b35462deebc/LICENSE)。独立解析命令与 patch；不加载卡内远程 MVU bundle。 |
| [ST-Prompt-Template](https://github.com/zonde306/ST-Prompt-Template/tree/d6f520d149aba146305b0b781ddd691d449c28d2) main `d6f520d149aba146305b0b781ddd691d449c28d2` | [README_CN.md](https://github.com/zonde306/ST-Prompt-Template/blob/d6f520d149aba146305b0b781ddd691d449c28d2/README_CN.md)、[API 手册](https://github.com/zonde306/ST-Prompt-Template/blob/d6f520d149aba146305b0b781ddd691d449c28d2/docs/reference_cn.md)；EJS、变量读取、动态注入 | [AGPL-3.0](https://github.com/zonde306/ST-Prompt-Template/blob/d6f520d149aba146305b0b781ddd691d449c28d2/LICENSE)。使用独立 EJS 包与自有桥接；未复制扩展源码。 |
| [Tavern Helper](https://github.com/N0VI028/JS-Slash-Runner/tree/6897ed6cda2ec27e8877e418161dfd3327010370) main `6897ed6cda2ec27e8877e418161dfd3327010370` | [README](https://github.com/N0VI028/JS-Slash-Runner/blob/6897ed6cda2ec27e8877e418161dfd3327010370/README.md)、[官方文档](https://n0vi028.github.io/JS-Slash-Runner-Doc/)；脚本、iframe、消息/变量/事件 API | [PolyForm Noncommercial 1.0.0](https://github.com/N0VI028/JS-Slash-Runner/blob/6897ed6cda2ec27e8877e418161dfd3327010370/LICENSE)。未打包上游代码，只独立实现下列接口子集。 |
| [SAKURAfan1023/dafeiyu-bot](https://github.com/SAKURAfan1023/dafeiyu-bot/tree/77e60399bd0d8059f1502946718e4034fc769258) main `77e60399bd0d8059f1502946718e4034fc769258` | [README](https://github.com/SAKURAfan1023/dafeiyu-bot/blob/77e60399bd0d8059f1502946718e4034fc769258/README.md)、`packages/avatar/README.md`、`docs/USER_GUIDE.md`；QQ 范围控制、记忆、工具、头像表现与暂停 | [MIT](https://github.com/SAKURAfan1023/dafeiyu-bot/blob/77e60399bd0d8059f1502946718e4034fc769258/LICENSE)。机制参考；不替换工作台 NapCat 和账户配置。 |
| [liqiming123/dafeiyu-qq-bot](https://github.com/liqiming123/dafeiyu-qq-bot/tree/edb5c09215a32cce5a69a93541ec7c9ed363ba75) main `edb5c09215a32cce5a69a93541ec7c9ed363ba75` | [README](https://github.com/liqiming123/dafeiyu-qq-bot/blob/edb5c09215a32cce5a69a93541ec7c9ed363ba75/README.md)、`plugins/fish_{voice,api_tool,qzone,help,mood,food}/`、`plugins/admin_only/`；语音/媒体、情绪、主动动态、求助、余额提醒 | [代码 MIT，人设 CC BY-NC 4.0](https://github.com/liqiming123/dafeiyu-qq-bot/blob/edb5c09215a32cce5a69a93541ec7c9ed363ba75/README.md#许可)。不复制人设与表情包；使用用户自己的角色、媒体与服务。 |
| [MaiBot](https://github.com/Mai-with-u/MaiBot/tree/c6429547af711555e3d4d1b8d04b413572cb616c) main `c6429547af711555e3d4d1b8d04b413572cb616c` | [README](https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/README.md)、[官方手册](https://docs.mai-mai.org/manual/)；对话决策与持续陪伴方向 | [GPL-3.0](https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/LICENSE)。工作台自行实现互动策略/表达记录，不声称复制完整 MaiBot。 |
| [LivingMemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/tree/1c6a471c9af9ae45a4ccb3a8cec5695c917de50b) master `1c6a471c9af9ae45a4ccb3a8cec5695c917de50b` | [README](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/blob/1c6a471c9af9ae45a4ccb3a8cec5695c917de50b/README.md)、`main.py`、`core/`、`storage/`；召回、关系图、归档/衰减/强化、合成唤醒隔离 | [AGPL-3.0](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/blob/1c6a471c9af9ae45a4ccb3a8cec5695c917de50b/LICENSE)。独立 SQLite 记忆服务，沿用工作台模型入口。 |

## 实际依赖与隔离

精确版本在根 `package-lock.json`：`quickjs-emscripten@0.32.0`（[MIT](https://github.com/justjake/quickjs-emscripten)）、`ejs@7.0.2`（[Apache-2.0](https://github.com/mde/ejs)）、`yaml@2.9.1`（[ISC](https://github.com/eemeli/yaml)）、`json5@2.2.3`（[MIT](https://github.com/json5/json5)）。JSON5 处理老式 InitVar 中的注释与未引号键。包内保留各依赖许可证。安装使用 `npm ci --ignore-scripts`，无需用户另装浏览器或模型。

EJS 使用真实 EJS 解析器生成代码；代码只在 QuickJS WASM 中编译执行。每次执行建立独立堆，仅传 JSON 副本，没有宿主对象、文件、网络、`process`、`require`、`fetch`。默认堆上限 24 MiB、JS 时间 250 ms，另有线程总时限以终止原生正则/WASM 长任务。执行器对外部 API 的限制是兼容边界，不等于关闭所有脚本。

`tools/package-workbench.mjs` 检查四项依赖存在，打包后调用 `framework/character-runtime/self-test.mjs`，实际执行 EJS、YAML、WASM、MVU 和超时路径。添加构建检查不等于已经完成一次完整打包。

## 运行层合同与检查

入口 `framework/character-runtime/index.mjs`：

- `parseCharacter(value)`：JSON v1/v2/v3、宿主 `{id,revision,raw}` 或 PNG Buffer；保留原始 `raw`，不写回导入文件。`parseCharacterFile({name,base64})` 返回原始 JSON；PNG 支持 `tEXt/zTXt/iTXt` 的 `chara/ccv3`，校验 CRC 和大小。
- `renderCharacter(character, options)`：`profile,lore,opening,beforeMessages,afterMessages,history,variables,trace,html,compatibilityDetails`。历史仅转换用户/助手文本，保留图片、`tool_calls`、工具回复、空 content。`afterMessages[].depth` 从历史尾部计数。`data.extensions.workbench.prompt_order` 调整五个人设字段的顺序。
- `processCharacterOutput(text, options)`：`text,variables,actions,html,trace`。变量块先解析并隐藏，显示正则与 HTML 随后处理。任一 patch 块失败保持该块之前的变量；不会执行原生命令之外的任意文本。
- `runCharacterScript(code, options)`：`result,variables,messages,actions,trace`；脚本只能改本次副本，由宿主决定何时持久化或投递。

| 能力 | 实现与测试证据 | 边界 |
| --- | --- | --- |
| 原卡、JSON/PNG、人设/示例/开场 | `card.mjs`；原卡副本与 CRC 回归 | 原 PNG 文件不修改；工作台读取角色元数据，导出的 JSON 不包含 PNG 像素 |
| 世界书 | `index.mjs`；四种次条件、递归、概率、字符预算、外部书、扫描/插入深度 | 预算明确按字符；不假装模型 token 计数。组竞选、向量触发、sticky/cooldown/delay、作者注释锚点和 outlet 未实现 |
| EJS/宏 | `sandbox.mjs,text.mjs`；循环、条件、await、变量宏、错误和禁用提示 | 每条模板独立作用域；无跨条目词法共享。文件 include、完整 STScript、预设与远程 API 不支持 |
| MVU | `variables.mjs`；原生命令、官方 delta/insert/move、RFC 6902、JSON Pointer、原子失败、禁止原型路径、开场初始化 | 直接脚本 schema/zod、自动远程 MVU bundle、完整多楼层 swipe 状态不等同于上游 |
| 正则/HTML | `text.mjs`；显示与 promptOnly 分流、深度、输出 HTML | HTML 返回数组交给受限 iframe，不能当主页面 HTML 注入；不自动访问 CDN |
| 脚本 API | `sandbox.mjs`；变量替换、事件回调、消息动作、注入提示词、宿主访问和超时回归 | 按下表 API 子集，不承诺任意第三方脚本无需改动 |

可执行测试：`node --test tests/character-runtime.test.mjs`；运行端自检：`node framework/character-runtime/self-test.mjs`。当前覆盖 22 个运行层用例，包含老式 MVU 的值/说明二元数组和 display_data；真实 QQ 外发、用户模型生成、完整桌面包与第三方真实卡验收属于对应集成检查，不能用这些 fixture 代替。

## Tavern Helper / EJS API 子集

| 类别 | 已实现 | 明确不支持 |
| --- | --- | --- |
| 当前变量 | `getVariables/getAllVariables/replaceVariables/updateVariablesWith/insertOrAssignVariables/insertVariables/deleteVariable`；`getvar/setvar/incvar/decvar/delvar`；`Mvu.getMvuData/replaceMvuData` | 全局/预设/扩展/任意历史楼层作用域；`registerMvuSchema/registerVariableSchema`；内嵌 `Mvu.parseMessage` |
| 消息副本 | `getChatMessages/getChatMessage/setChatMessages/createChatMessages/deleteChatMessages/getLastMessageId/getCurrentMessageId` | 自动发送 QQ、自动模型生成、真实聊天删除；这些动作须由宿主路径处理 |
| 世界书/角色 | `getWorldbook/getWorldbookNames/getwi/getCharData/getchar` | 读取未由宿主提供的书、修改全局世界书和角色文件 |
| 事件/启动 | `eventOn/eventOnce/eventEmit/eventRemoveListener/eventClearAll`、`waitGlobalInitialized`、`$(callback)` | DOM jQuery、常驻后台线程、跨请求 listener；每次请求重建脚本并触发对应 generation/MVU/message 事件 |
| 提示词/日志 | `injectPrompt/injectPrompts/uninjectPrompts/getPromptsInjected/hasPromptsInjected`、`console`、`toastr` | `generate/generateRaw/triggerSlash/execute`、自动网络工具调用 |
| 工具函数 | `_` 的 `get,set,unset,has,cloneDeep,merge,clamp,isEmpty,keys,values,entries,toPairs,map,forEach,sum,pick,omit` | 完整 lodash、zod、Vue、faker、浏览器宿主 API |

HTML 桥接协议由编辑器实现：`channel: 'workbench-character-frame'`、`nonce`、`requestId`、`action`。iframe 仅访问本次预演的变量/消息；持久化通过外部保存状态操作。

## 持续陪伴能力的工作台落点

这些功能由同一开发任务的服务、模块适配器和编辑器负责；以它们的集成测试及交付记录为验收证据，不能由运行层的测试数推导为完成。

| 研究能力 | 工作台落点 | 验收条件 |
| --- | --- | --- |
| 长期记忆、关系图、关键词/向量召回、生命周期 | `framework/character-life/` SQLite 服务 | 隔离/分享开关、来源、修订删除、归档、衰减、真实 embedding 配置 |
| 情绪、关系、活动、日记与反思 | 角色状态和对话后观察 | 仅确认成功对话写入；失败与合成唤醒不伪造经历 |
| 表达学习和群聊旁观 | 表达库、QQ 消息观察和 `decide` | 可编辑禁用、来源可查，暂停和人工接管优先 |
| 主动聊天、安静时段、额度 | `CharacterLife.tick` 与模块 `deliver` | 显式启用、取消、去重、未知送达不重发 |
| 心情动态、求助、余额/吃饭提醒 | 自动化配置和 OneBot/HTTP 工具 | 有平台配置和真实响应；未知余额不能编造 |
| 表情包、视觉、语音、形象动作 | 媒体工具与已有绘图/语音/形象桥接 | 用户资源，结果回到当前对话；无默认模型下载 |
| 可配置 API 工具 | 角色工具目录 | 调用选定工具，凭证不注入角色提示词 |
