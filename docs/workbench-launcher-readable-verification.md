# 启动器效果说明 0.7.1 验证

2026-11-06，按念念确认的「像绘世一样，每项下面固定显示一句效果说明」调整。30 项设置使用用途名称、常驻效果和取舍说明，技术细节保留在 info。字段键、枚举值、默认值与启动参数语义不变。

例如「显存模式」改为「省显存程度」，说明更省显存通常更慢；「在 CPU 运行 VAE」改为「用 CPU 处理图片」，说明图片转换更省显存但会变慢；过程预览明确不会改变最终成图尺寸。互斥设置的错误消息同步使用新名称，并说明恢复办法。

## 构建与检查

- 源码分支：`fix/launcher-readable-settings`。构建源 `219ee9a9d2b5c5822a58ad69de4a0ee381c7b3a4`，构建时工作区干净。
- 0.7.1 输出：`dist-workbench-launcher-readable/win-unpacked/AI未来 工作台.exe`；0.7.0、0.6.0 和当前旧窗口保留。
- 包内版本、9 模块与构建记录一致，68 项核心文件 SHA256 与源码逐字节匹配。随包 AIRI Minecraft 隔离执行器自检通过。

| 验证 | 结果 | 证据（相对本工作区） |
| --- | --- | --- |
| 参数、运行和双入口回归 | 57/57，0 失败、0 跳过，真实 Python AST/转换 | `qa/launcher-readable/regression.log` |
| 最后文案调整后的参数回归 | 25/25，包含在上述相关测试范围内 | `qa/launcher-readable/options-final.log` |
| 源码启动器 GUI | 12 组通过，无页面错误 | `qa/launcher-readable/source-ui/result.json` |
| 最终 EXE 启动器 GUI | 12 组通过，无页面错误 | `qa/launcher-readable/packaged-launcher/result.json` |
| 最终 EXE 工作台 GUI | 32 组通过，无页面错误 | `qa/launcher-readable/packaged-workbench/result.json` |
| 原生关闭与草稿 | 关闭前草稿实际落盘 | `qa/launcher-readable/packaged-workbench/lifecycle-result.json` |
| 核心源码一致性 | 68 项通过 | `qa/launcher-readable/package-identity.json` |

实际查看了桌面、浅深色、390px 与 125%/200% 缩放截图。全部 30 项效果说明与控件关联，页面没有横向溢出；保存、草稿、单项还原、禁用选项的可访问说明和实际参数数组继续通过。JS/PowerShell 语法、UTF-8 无 BOM、乱码扫描与 diff 检查通过。

UI detector 返回 8 项 advisory，无阻断项：涉及既有圆角/颜色及字号。保留当前工作台材质；14px 标签、12px 效果说明是本表单明确采用的层级，不扩展修改旧设计系统。

统一入口仍为分类根目录的 `打开 AI-未来工作台.lnk`，验收后更新启动脚本优先选择 0.7.1。升级前入口、说明与脚本备份在 `备份/启动器说明升级前入口-20261106-192442`。正式用户资料未迁移，未强制关闭当前窗口。

本轮只改文案与说明呈现，没有执行真实 ComfyUI 启动、模型推理或依赖安装。GUI 的服务/诊断使用隔离夹具；临时 Node 进程验证与最终 EXE 界面验证是真实运行，不视为推理证明。
