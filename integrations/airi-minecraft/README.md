# AIRI Minecraft 工作台适配

来源为 AIRI v0.15.1，提交 `89ec1e953f2e3b6f529d1f387d19bf5678ec6814`。`upstream` 保存 Minecraft 服务源码，原始文件哈希在 `source-manifest.json`。适配文件的哈希和原因在 `adaptations.json`。AIRI 原始 MIT 许可见 `LICENSE.AIRI`。

`worker.mjs` 加载上游 Mineflayer 包装器、CognitiveEngine、感知规则、反射、Brain、TaskExecutor 和技能。工作台使用 IPC 承接原 AIRI 事件客户端的接口，没有依赖正在运行的 AIRI 桌面实例。调试 HTTP、MCP 和 Viewer 服务均关闭。

开发环境需要 Node.js 24 或更新的兼容版本。先安装独立依赖，再运行真实隔离执行器检查：

```powershell
npm --prefix 'integrations/airi-minecraft' ci --omit=dev --no-audit --no-fund
node --no-node-snapshot 'integrations/airi-minecraft/worker.mjs' --self-test
```

Minecraft 协议库需要统一的数据集版本，独立依赖固定使用 `minecraft-data@3.119.0`。`typescript` 是上游代码规范化器的实际运行依赖，已显式加入清单。解析器、原生 `isolated-vm` 和其他依赖由 `package-lock.json` 锁定。

桌面打包通过 `extraResources` 带上此运行端、依赖和当前构建使用的 Node 可执行文件。模型与游戏文件不在此目录。运行数据及微软登录缓存由宿主放在工作台专属数据目录内。

当前 Mineflayer 运行端被上游标记为向 Fabric 方案迁移中的实现。工作台通过 `framework/mc-play.mjs` 的连接、指令和状态接口隔离这部分实现。

多 Bot 运行时，IPC 提供动态同服 Bot 名单，并在连接游戏 socket 前复核微软解析后的真实身份。认知入口只过滤这份名单中的聊天，不按名称猜测机器人。

`skin-application.mjs` 观察本连接玩家 UUID 的 `player_info` 纹理，使用 `/skin set web classic|slim "<官方纹理 URL>"` 或 `/skin clear` 请求兼容 SkinRestorer。运行端通过 `skinProtocol:1` 声明能力；皮肤来源必须是 `textures.minecraft.net` 的固定纹理路径。应用结果与最新观察分别通过 IPC 上报，主进程核对会话、请求、图片版本及最新材质后才确认成功。此文件随 MC 可选组件一起打包，旧运行端须更新后重新连接。

指定坐标建造使用 `placeBlockAt({type,x,y,z})`，坐标须为整数。运行端负责取真实方块、接近目标、装备精确匹配的材料并放置，随后核对世界中的结果。目标已有同种方块时直接确认；被其他方块占用时返回错误，不自动拆除。建造会解除自动跟随，避免寻路互相干扰。查询快照不能作为原生方块传给 `botCall("placeBlock")`。
