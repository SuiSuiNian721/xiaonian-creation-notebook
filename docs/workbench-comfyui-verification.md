# ComfyUI 绘图模块交付验证

记录日期：2026-11-06（北京时间）。工作台版本：0.5.0。

开发分支：`feat/comfyui-drawing-complete`，基于 `2b52967`。
交付工作区：`E:\AI-未来\ai-future-comfyui`。同仓库的 MC 模块正在另一工作区开发，本分支只包含绘图与共用 AI 接入相关改动。

## 最终源码与打包验证

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| `node --test tests/*.test.mjs` | 130 通过，0 失败 | `qa/tests-final.log` |
| Windows Electron 打包 | 退出码 0，版本 0.5.0 | `dist-workbench/build-record.json` |
| 打包 EXE 工作台回归 | 32 组通过，无界面异常 | `qa/packaged-final/result.json` |
| 打包 EXE 关闭与草稿落盘 | 通过 | `qa/packaged-final/lifecycle-result.json` |
| 打包资源绘图专项 | 8 组通过，无界面异常 | `qa/drawing-packaged-final/result.json` |
| 独立代码审查 | 3 项重要问题修复并复核通过 | 对应 `tests/drawing.test.mjs` 与绘图 GUI 检查 |

绘图专项通过实际窗口、表单、文件输入、HTTP 路由、数据库、图片下载与磁盘归档运行；ComfyUI 和 AI 上游使用隔离协议服务。覆盖上传参考图后刷新选项、切页恢复、提交的节点图确实使用新图片，以及 AI 候选需主动采用、不自动生成。深浅主题、125% 缩放和 390px 窗口通过。截图中的白色图片为测试夹具，不能用作真实推理证明。

参考图回归在修复前的打包代码上失败于“上传图片被选中”，记录在 `qa/drawing-upload-red/failure.json`；同一检查在修复后的打包资源上通过。后端新增用例覆盖取消时排队转运行、取消与完成重叠、旧服务缺少按任务取消接口，以及作品目录复制失败不重复落盘。

工作台回归包含原角色卡编辑、JSON/PNG 导入导出、窗口重载与关闭保存草稿、全局 AI 设置入口、模块隔离和无自动外联。资源安装界面使用夹具，未执行真实模型或节点下载。

## 本次会话真实联调

这些真实联调在移入独立工作区前完成，原始记录保留于 `E:\AI-未来\ai-future-demo\qa`。独立工作区内 `qa/live-evidence` 仅复制结果 JSON，未复制用户资料或密钥。

- **ComfyUI**：使用现有 `E:\ai draw\ComfyUI-aki-v2\ComfyUI` 和原嵌入式 Python，服务版本 0.42.0，RTX 4060 Laptop 8GB。未安装第二套 ComfyUI，也未向其 Python 环境安装依赖。
- **工作流**：导入现有 `E:\ComfyUI工作流\MOSS-Image_SFT_INT8_8GB_文生图.json`，转换得到 10 个 API 节点、22 个可编辑字段。原件保留。
- **真实生成**：4 步任务完成，实际 PNG 为 1024×1024。任务 ID `df436582-69e3-4cc3-98fa-91808fe95a27`；图片 SHA256 `8beda50922e7bd6147bcacfbfdb1b8ec22250ba6c73c347d36d7ab90e9dfa738`。
- **图片位置**：`E:\AI出图\AI未来工作台\df436582-69e3-4cc3-98fa-91808fe95a27\ef449ba4-4cb2-46e2-b385-5a7df6d1516a.png`。图像为蓝色陶瓷杯与白色花朵，已实际查看。
- **Codex 共用连接**：真实 CLI 调用返回 HTTP 200 / `OK`；真实工作流助手将 KSampler 步数从 25 改为 6，候选导入校验通过，保留模型、提示词和连线；该候选未执行。
- **MCP**：自动测试启动真实 stdio 子进程，经本机 HTTP 服务完成初始化与工具请求；验证默认关闭、令牌、同源边界，以及工作台端口变化后重新读取连接文件。未修改用户现有外部 AI 客户端配置。

对应结果为 `qa/live-evidence/comfy-result.json`、`ai-connection-result.json`、`ai-workflow-result.json`。

## 验证边界与使用方式

没有使用真实付费 OpenAI 兼容服务；此路径通过隔离 HTTP 服务核对认证头、模型、消息与响应解析。原生 ComfyUI 浏览器打开动作在 GUI 测试中验证了桌面回调；完整节点画布仍由 ComfyUI 自身提供。

启动入口为工作区根目录的 `打开工作台.cmd`，打包程序位于 `dist-workbench\win-unpacked\AI未来 工作台.exe`。操作步骤见 [ComfyUI 绘图模块](workbench-comfyui.md)。共用设置供角色卡、绘图与后续模块使用；MCP 默认关闭，启用后可导出外部客户端配置。
