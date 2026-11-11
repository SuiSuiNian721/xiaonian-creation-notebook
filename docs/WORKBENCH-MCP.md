# 工作台 MCP 接入

工作台提供统一 MCP 服务。外部 agent 连接正在运行的工作台，直接使用已有实例、工作流、任务与产物；无需为某一种 agent 安装专属插件。

## 连接

1. 打开桌面「AI-未来工作台」。
2. 在「全局设置 → AI 接入」勾选「启用工作台 MCP」，保存。
3. 展开「MCP 接入」，选择「导出客户端配置」。把导出的 `mcpServers.ai-future-workbench` 加入客户端。

推荐 stdio：客户端启动 `tools/workbench-mcp.mjs`，它每次请求读取资料目录中的 `mcp-connection.json`，自动跟随工作台重启后的端口。工作台必须保持运行。导出的配置已经包含当前 Node/Electron 路径及 `ELECTRON_RUN_AS_NODE=1`，无需手工填写令牌。

「复制 HTTP 配置」提供当前 `/mcp` 地址和 Bearer 请求头。HTTP 使用 Streamable HTTP 的 JSON 响应模式，POST 接收请求、通知返回 202；不提供独立 SSE 订阅，GET 返回 405。版本协商支持 `2025-06-18`、`2025-03-26`。实现依据 [MCP 传输规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) 和 [生命周期规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)。

服务只供本机连接，校验 Host、Origin 与令牌。HTTP 配置含访问凭据，不要放进公开仓库。外部 agent 可使用自己的模型；只有明确调用皮肤制作、训练规划等需要工作台 AI 的功能时，才使用对应实例已配置的 AI。

绘图面板中的「绘图实例 MCP」仍可使用，但仅访问那个实例；全局设置导出的连接才是统一入口。所有入口共用全局 MCP 开关，每个入口有自己的令牌；绘图面板的「管理工作台 MCP」可返回全局设置。

## 发现与实例选择

依次调用：

```text
workbench_modules {}
workbench_instances {}
workbench_tools {"moduleId":"drawing"}
```

`workbench_modules` 返回模块名称、工具名称和 `coverage`。`operations` 表示已有业务工具，`state-only` 表示仅接入状态查询；这不等于模块的全部 UI 功能都已开放。

根入口的业务工具都声明必填 `instanceId`，必须从 `workbench_instances` 返回值选择。没有合适实例时，可明确调用 `workbench_instance_create`；已有实例为 stopped 时调用 `workbench_instance_start`。启动实例只初始化业务运行端，不自动开始出图或训练。

例如已获得绘图实例 UUID 后：

```json
{
  "name": "comfy_status",
  "arguments": {
    "instanceId": "从实例列表复制的绘图实例 UUID"
  }
}
```

不存在、已停止、类型不匹配的实例会返回错误，不会改用其他实例。调用已迁移的资料必须指定实例；没有实例、尚未迁移的旧绘图入口仍兼容历史调用。实例自己的 MCP 入口可以省略 `instanceId`，但不能传入另一个实例。

## 当前覆盖

| 模块 | 已接入能力 |
| --- | --- |
| 角色绘图 | 连接与真实节点定义、工作流导入读取、依赖缺失报告、来源搜索、选定模型下载、引用替换副本、节点安装计划、生成与取消、结果查询 |
| ComfyUI 启动器 | 本地模型和节点库存、下载与哈希校验、管理计划与应用、日志、快照、启动参数、环境诊断、启动与停止预览/确认 |
| LoRA 训练 | 原有训练 MCP 全套工具：状态/类型/schema、预设、预检、稳定 requestId 提交、任务与产物、处理流程、暂停/继续/取消 |
| MC 皮肤 | 环境检查、参考图或原皮肤上传、已配置皮肤导入、制作、版本与校验结果、取消与确认 |
| 角色卡、声音、虚拟陪伴、角色资料、QQ 对话、MC 陪玩及其变体 | 实例发现与启动、`workbench_module_state` 状态查询。编辑角色卡、合成语音、发送消息和操控游戏尚未开放为 MCP 操作 |

工作流补全沿用工作台原有能力：检查实际模型/节点依赖，搜索候选，按选择下载或安装；不会保证自动修复任意连线错误、节点版本变化或任意安装脚本。

工具的实时 `inputSchema` 是参数依据，不要自行猜测工作流 ID、模型名称或资源候选 ID。默认 HTTP/stdio 请求上限为 2 MiB，较大的图片先在工作台界面上传，再使用已有资源 ID。

## 任务与结果

统一查询入口：

```text
workbench_tasks       {instanceId, kind?}
workbench_task        {instanceId, kind, id, refresh?}
workbench_task_cancel {instanceId, kind, id}
```

任务类型为 `drawing`、`completion`、`download`、`management`、`training`、`training-workflow`、`skin`。每个实例只接受属于自己模块的类型。返回记录包含 `instanceId`、`kind`、`id`、`status` 和完整原业务 `task`；产物、日志与校验字段仍在 `task` 内。某类型暂不可读取时，列表的 `unavailable` 会说明原因。

生成、下载、训练请保留提交时的 `requestId`。响应超时先查询原任务或提交记录，再用原 requestId 重试；不要换 ID 自动补交。stdio 可并发转发查询与取消。传输断开或 MCP 通知不等于业务任务已经取消，应调用业务取消工具并核对状态。

下载的统一“取消”会暂停并保留续传资料；环境安装任务不支持中途取消。停止训练可能无法保存当前步骤。ComfyUI 的按任务取消取决于服务版本，工作台不会为取消一张图清空其他任务。

结果与界面使用同一份实例资料。返回的 `/instances/<UUID>/api/...` 链接已限定实例，可在当前工作台 HTTP 地址下打开。`workbench_task` 只读取业务记录中的产物，不提供任意本地文件读取。

## 典型绘图流程

1. 查询并选择绘图实例，`comfy_status` / `comfy_connect` 核实连接。
2. `comfy_nodes` 读取真实节点与模型选项。
3. `comfy_workflow_complete` 建立依赖报告，`comfy_completion_report` 查询结果。
4. 有缺失时使用 `comfy_completion_search`；模型使用明确候选调用 `comfy_completion_download`；节点先 `comfy_completion_node_plan`，展示具体变更后 `comfy_manager_apply`。
5. 补齐并按需要重启服务，再检查和导入工作流。`comfy_completion_copy` 可按选择替换引用并保留原稿。
6. 用户要求开始出图后调用 `comfy_generate`，使用原 requestId；通过 `workbench_task` 或 `comfy_job` 查询进度与作品。

本接口没有附加 DSH 运行依赖，也没有改写已有 DSH 配置。
