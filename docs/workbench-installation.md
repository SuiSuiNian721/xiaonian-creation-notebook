# 模块内资源安装接口

版本 0.4.0。添加模块保持原行为，仅启用入口；资源安装在模块的“资源安装”页签内完成。角色卡编辑组件已随程序提供，资源页显示内置版本和无需下载；其可下载清单为空，其他模块沿用以下安装规则。

## 规则

前置依赖始终加入计划、优先于附加文件安装，不能通过前端漏选跳过。附加文件默认不选，选择按模块保存在 SQLite。资源状态与模块启用状态分开：没有就绪的前置时不允许后续业务执行，但不影响配置和资料管理。

确认面板展示名称、版本、来源、下载量、新增占用和安装目录。字节数为整数或 `null`，未知值展示“待确定”；已安装资源不计入新增下载和占用。计划摘要包括清单、选择与安装记录，确认时重算，变化后必须重新查看清单。

其余七个模块的正式清单只有待接入前置，没有可选文件、下载地址或生产安装适配器，不会执行真实下载。现有已安装状态来自适配器之前验证过的记录，不包含对本机其他工具的扫描；后续适配器需要实现已有安装的识别、校验及重新检查。

桌面版通过“选择文件夹”调用 Windows 原生目录对话框。各模块独立持久化选择，取消不变更位置；选择过程不创建资源文件。安装时固定使用确认计划中的目录。更换目录会使原计划失效，原文件保留；安装记录只对其原目录生效。旧版未记目录的记录仍对应默认安装目录。

选择器与同模块安装互斥，不重复弹窗。用户浏览文件夹期间不套用普通 API 的 15 秒超时。纯 HTTP 开发服务没有系统对话框，返回 `canChooseDirectory:false`，界面禁用选择按钮。

## 接口

以下路径均以 `/api/modules/:id/resources` 开头：

| 方法与路径 | 输入与结果 |
|---|---|
| GET `/` | 资源、安装目录、可选选择、前置就绪及最近任务 |
| POST `/choose-directory` | `{}`，调用桌面选择器并保存；返回新状态与 `cancelled`，拒绝前端直接提交路径 |
| PUT `/selection` | `{optionalIds:[]}`，持久化可选选择，前置由服务端加入 |
| POST `/plan` | `{optionalIds:[]}`，只读生成清单和 `planId` |
| POST `/install` | `{planId,optionalIds:[]}`，确认后创建任务；未添加模块、过期计划或不可安装资源返回 409 |
| POST `/cancel` | `{taskId}`，请求当前模块任务中止 |

任务为 `queued / running / completed / failed / cancelled / interrupted`。进度字段 `completedBytes/totalBytes` 对应 `currentResourceId` 的当前资源；没有字节信息时用不定进度，不通过计时器编造百分比。离开页面不取消任务；退出应用中止任务，重启保留中断状态。

## 接入资源和适配器

`framework/resource-catalog.mjs` 定义生产目录。可信启动代码可通过 `createWorkbench({resourceCatalog,installationAdapters})` 注册目录和适配器。禁止从 HTTP、角色 JSON 或服务地址配置注入可执行安装器。

桌面启动代码还注入 `chooseDirectory({moduleId,defaultPath})`，返回已选择的绝对目录或 `null`（取消）。路径经存在性与目录类型校验后保存。HTTP 不能覆盖此回调或指定执行代码。

目录以模块 ID 索引，包含 `revision` 和 `resources`。每项字段：`id,name,version,required,status,sourceLabel,downloadBytes,installedBytes,adapterId`。`status` 为 `available` 或 `pending`；生产资源应填写已核实版本、来源与大小。目录可以包含由适配器使用的其他可信元数据，例如固定下载 URL 和哈希；不能由前端请求替换。

适配器提供：

```js
{
  async install({ moduleId, resource, directory, signal, report }) {},
  async verify({ moduleId, resource, directory, signal }) { return true; }
}
```

上面的函数体仅表示签名；真实 `install` 必须执行对应文件操作，`verify` 必须完成实际检查。只有校验明确返回 `true` 才标记安装完成。适配器必须响应 `signal`，否则应用等待其退出时可能无法完成关闭。下载、解压、防路径穿越、哈希校验和已有文件检测由具体适配器负责。

`report({stage,completedBytes,totalBytes})` 仅报告实际阶段与当前资源的字节进度。未报告总量时保持 `null`。同模块禁止同时运行两个安装任务；失败或取消不会把未验证的文件标为已安装，也不会自动删除用户文件。

## 验证边界

后端测试使用临时目录内的四字节测试文件验证安装、校验、取消、失败、前置优先及重启恢复；GUI 夹具使用明确命名的流程测试资源验证勾选、汇总和任务显示。这些资源不进入正式目录，没有真实网络下载或系统安装。
