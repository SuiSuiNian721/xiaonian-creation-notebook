# 模块开发约定

## 边界

工作台由 `framework` 本机服务和 `public-workbench` 单一前端组成。模块是宿主内的功能单元，不是独立网站或单独桌面应用。前端只加载已添加模块的视图。

`framework/registry.mjs` 的清单描述业务能力及配置字段。`framework/store.mjs` 持久化模块状态、角色、资源索引与日志。`framework/server.mjs` 提供同源、回环访问的 HTTP 接口。此服务不导入旧 Demo 的聊天、QQ 或 AIRI 运行域。

模块不得导入其他模块的实现或直接访问数据库。内置模块共享运行环境，这是一项工程边界，不是执行不可信插件的沙箱。

## ModuleDefinition

每个清单包含：

```js
{
  id: 'drawing', name: '角色绘图', version: '0.1.0',
  category: 'create', icon: 'drawing', accent: '#d781a1',
  subtitle: '目录检索文本', description: '在 info 提示中呈现的功能说明',
  requirements: ['ComfyUI'], optionalIntegrations: ['LoRA'],
  capabilities: [{ id: 'generation', label: '图像生成', status: 'planned' }],
  settings: [{ key: 'serviceUrl', label: '服务地址', type: 'url', placeholder: 'http://127.0.0.1:8188', help: '补充说明' }]
}
```

`status` 为 `planned` 或 `available`。只有经过真实接入验收的能力才能标记为 `available`。配置类型为 `text`、`url`、`path`；路径可指定 `pathKind: file | directory | either`。新增字段时应同时处理已有配置默认值。

模块可声明 `usesCharacterContext:false`，隐藏该模块的顶部角色选择器和概览角色侧栏。角色卡是人设创作模块，使用此声明；它不改变其他模块已经选定的角色，也不删除角色资料。

`comfyui` 为环境入口，同样不绑定角色。其配置与路径检查由服务端映射到唯一的 `drawing` 配置行；前端两处使用 `module:drawing` 草稿键，保存时只提交各自显示的字段。首建 `comfyui` 行时继承此前已启用的 `drawing` 状态，之后重启不覆盖用户停用。运行/维护可由任一入口启用，工作流与生成仍只要求 `drawing`。

新增模块时在注册表添加定义，在前端 `modules` 内添加自己的入口，并加入 `app.js` 中明确的模块路径映射。禁止通过导入角色卡或配置内容提供可执行模块路径。

## ModuleContext

模块入口导出 `mount(root, context)`。宿主传入：

- `state`：当前工作台状态的只读使用视图。
- `signal`：离开模块时取消事件监听及过期界面更新。
- `api`、`refresh`：调用工作台接口及更新状态。
- `drafts.read/write/commit`：按命名空间保存会话草稿；提交只能清除与已保存快照相同的草稿。`reconcile(key, submitted, saved)` 用于配置字段规范化，仅同步提交后未继续编辑的字段。
- `navigate`、`notify`、`action`：宿主导航、反馈和按钮忙碌状态。
- `characters.getSelected()`、`assets.list()`：读取当前角色及资源清单。
- `tasks.list()`：读取资源安装与绘图任务列表。
- `ai.complete(moduleId, messages)`：使用工作台公共 Codex / OpenAI 兼容连接，模块不得自行保存另一份密钥。HTTP 为 `POST /api/ai/chat`。

配置使用 `module:<id>` 草稿键。未来角色专属业务应同时使用 `characterId`，切换角色时不得把旧请求结果写入新的角色上下文。所有异步界面更新应检查 `signal.aborted`；后台保存与界面切换分开处理。

标准模块视图在 `module-view.js`；各模块入口提供流程与折叠说明。后续复杂编辑器可实现自己的 `mount`，继续使用同一宿主组件和上下文。

角色卡使用独立的 `modules/cards.js`。宿主将其挂载到持续连接 DOM 的 `#cards-content`，切换模块只隐藏，避免 iframe 重插导致页面重载。共享角色选择器仍隐藏。默认“创作”标签提供作品列表和编辑器，“资源安装”“接入配置”“运行记录”为次级标签。

`framework/card-studio.mjs` 托管内置的小汐服务：按需启动回环随机端口的子进程，资源复制到独立工作区并核对原始哈希，OS 级锁避免两进程并写。`POST /api/modules/cards/studio` 返回工作台内路径 `/card-studio/`、工作区路径和来源版本。所有 `/card-studio/` 请求经过工作台的同源和模块启用检查，再附加私有令牌转发；SSE 与下载按流处理。`card-studio-embed.mjs` 仅适配页面接口前缀、头像 URL、主题与宿主钩子，原始代码快照保持原样。

父页面通过 `__workbenchFlushDrafts` 在离开前持久化草稿，失败保留当前页面；桌面关闭使用 `__workbenchPrepareExit`，失败时调用取消钩子并保留窗口。正常重载也先保存草稿。成品目录打开只接受经后端验证的创作工作区内目录。关闭宿主会停止子服务及其聊天桥。

## 资源安装

模块内的“资源安装”由 `installation-view.js` 挂载，使用 `framework/resource-catalog.mjs` 和 `framework/installations.mjs` 提供的清单、确认与任务接口。前置必选并优先执行，可选文件按模块保存选择。安装状态与模块启用状态独立，具体资源和适配器约定见 [资源安装接口](workbench-installation.md)。

## HTTP 接口

| 接口 | 作用 |
|---|---|
| `GET /api/state` | 模块、角色、选中角色、主题、日志及任务 |
| `POST /api/modules/:id/enable` | 添加模块 |
| `POST /api/modules/:id/disable` | 移除入口，保留数据 |
| `POST /api/modules/:id/open` | 记录真实打开，要求模块已启用 |
| `PUT /api/modules/:id/config` | `{values:{字段:文字}}`，按清单校验并保存，返回 `{ok,config,checks}` 作为该次保存的规范化快照 |
| `POST /api/modules/:id/check-paths` | 检查已保存路径，过期结果不能覆盖新配置 |
| `POST /api/characters` | `{name,description?,raw?}`，创建角色 |
| `POST /api/characters/select` | `{id}`，允许 `null` |
| `POST /api/characters/import` | `{document}`，导入 JSON |
| `GET /api/characters/:id/export` | 导出资料包并记录操作 |
| `GET /api/events?moduleId=...` | 获取全部或指定模块记录 |
| `POST /api/events` | 报告已允许的模块加载事件 |
| `POST /api/preferences` | `{theme:'light'|'dark'}` |

服务地址只校验格式，不发起网络健康探测；连接状态不能从“配置非空”推断。配置变更清除相应旧路径检查结果。模块停用保留记录与配置。错误使用 `{error:'简体中文说明'}` 返回。

## CharacterBundle

```json
{
  "format": "ai-future-character",
  "schemaVersion": 1,
  "character": {
    "id": "stable-character-id",
    "name": "角色名称",
    "description": "简介",
    "revision": 1,
    "raw": {"name": "角色名称", "custom": {"保留": true}},
    "assets": []
  }
}
```

普通卡 JSON 从顶层或 `data` 中读取名称与简介，原卡字段完整保存。工作台不把自己的配置、密钥、聊天记录加进导出文件。素材信封只接受约定字段与相对引用，丢弃绝对路径等非便携字段。原卡本身的内容保持原样，分享前由创作者决定哪些设定适合分享。

导出使用紧凑 JSON，创建或导入前按照完整导出后再导入的请求信封进行 UTF-8 大小检查。同 ID 同内容导入幂等，不同内容或版本返回冲突。版本管理目前保存导入的版本号，不自动合并或覆盖。
