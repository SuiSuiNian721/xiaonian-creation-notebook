# MC 皮肤制作

从工作台「添加模块」添加 **MC 皮肤**，在「创作」页制作。Skill、两种已确认眼型和离线 3D 预览组件随工作台提供，无需另装模块包。

## 使用

1. 在「工作台设置」保存并启用共用 AI 连接，支持本机 Codex 或具有图片理解能力的 OpenAI 兼容接口。
2. 打开 MC 皮肤，确认「像素工具已就绪」。本机需要 Python 3.10+ 与 Pillow；自动查找失败时，在「接入配置」填写 Python 可执行文件，保存后检查环境。
3. 填写作品名称，添加角色参考图，选择 Slim / Classic 和「第一种角色眼睛」或「第二种角色眼睛」，输入制作要求，点击「制作皮肤」。最多三张参考图，PNG / JPEG / WEBP，每张不超过 8 MiB。
4. 已有原生皮肤先选择对应模型，再点「原皮肤」导入。支持原生 64×64 PNG，导入会检查基础层、Alpha 和 UV；默认保留原有眼型。也可在「接入配置」保存本地 PNG 路径，选好模型后点「导入此皮肤」。
5. 制作完成后查看立体、展开图和逐面分层图，切换视角、基础层及外层。点击「下载 PNG」取得原生文件；检查清单和独立 HTML 离线预览可分别下载。
6. 点击「继续修改」输入下一轮要求，生成新版本。原参考、原皮肤和既有产物不会被覆盖。「确认版本」只确认这一份作品，不改变通用眼型模板。

制作期间可以继续编辑下一次要求。切换模块保留当前会话的输入和已上传参考；关闭工作台后，作品版本和任务记录仍保存，未提交文字草稿不作跨重启承诺。取消会中断本次制作；重启遗留的未完成任务显示为「已中断」，不会自动重发 AI 请求。

## 原理与文件

AI 接收真实参考图、当前角色资料和 `minecraft-pixel-skin` 规则，输出逐面像素 JSON。Codex 使用显式 `skill` 与 `localImage` 输入；兼容 API 使用视觉消息。工作台随后调用 Python 适配器，复用 Skill 的 UV、合成、模板和校验脚本，不执行 AI 返回的程序。

两种眼型固定为 `eye_A` / `eye_B` 1.0.0。Slim 使用三格宽手臂，Classic 使用四格；新作需包含全部 36 个基础面。修改中 `.` 保留原像素，`-` 仅清空外层。特殊发丝保留或遮眼调整必须提供逐格依据，产物仍是角色专用候选。

默认数据目录：`%APPDATA%\AI-Future-Workbench\data\mc-skin`。

- `uploads`：独立复制的参考图和原皮肤。
- `jobs\<id>\request.json`：像素方案与制作来源。
- `jobs\<id>\output`：`skin.png`、`layers.png`、`manifest.json`、`preview.html`。
- 数据库中的版本记录保存制作要求、模型、眼型、角色快照、参考身份、任务状态和确认时间。
- 清单保存采用模板及其哈希、源文件哈希、变化坐标、PNG 回读结果与验证边界。

可选「皮肤作品目录」会额外保存到其中的新目录 `AI未来皮肤\<id>`；不会替换该目录已有文件。选中了工作台角色时，成功产物同时登记到该角色的素材索引。

## 接口

统一前缀 `/api/modules/mc-skin/`，需要模块已启用，并沿用宿主的回环及同源限制。

| 方法与路径 | 用途 |
| --- | --- |
| `GET state`、`POST runtime/check` | 历史作品、模板和 Python 环境检查 |
| `POST uploads`、`POST import-configured` | 上传图像或导入已保存路径的原皮肤 |
| `POST jobs`、`GET jobs/:id` | UUID 幂等提交与查询异步制作 |
| `POST jobs/:id/cancel`、`POST jobs/:id/approve` | 取消与确认当前版本 |
| `GET uploads/:id` | 读取受管参考图 |
| `GET files/:id/:filename` | 读取四种受管产物；`?download=1` 下载 |

同一请求重试只保留一个任务，单个模块同一时间仅运行一个制作任务。错误不发布为成功作品，环境缺失不会用演示图片替代。

## 验证边界

像素和文件检查、桌面浏览器 3D 预览、用户确认、Minecraft 游戏内效果分别记录。通过 PNG / UV / Alpha 检查或点击确认，不等于在游戏里验证。此版本尚未执行 Minecraft 游戏内皮肤验收。

真实 AI 的隔离验证记录在 `qa/mc-skin-live/result.json`：通过实际 Codex、显式 Skill / 参考图和 Python，仅修改指定的一格，源 PNG 与其余 4095 格不变。完整桌面流程另用确定性 AI 夹具与实际 Python / WebGL 检查，不能替代真实模型的美术质量验收。源码与打包验证记录分别保存到对应 QA 目录。

Skill 来源清单见 `integrations/minecraft-pixel-skin/source-manifest.json`，原目录 `F:\codex\skills\minecraft-pixel-skin` 保持原样。`skinview3d` 使用随包保留的 MIT 许可。

本次交付的具体检查和边界见 [验证记录](workbench-mc-skin-verification.md)。
