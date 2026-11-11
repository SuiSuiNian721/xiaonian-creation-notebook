# MC 皮肤模块交付验证

记录日期：2026-11-06（北京时间）。工作台版本：0.5.0。

正式入口：`E:\AI-未来\ai-future-demo\打开工作台.cmd`。程序位于 `dist-workbench\win-unpacked\AI未来 工作台.exe`，MC 皮肤入口已启用。共用 Codex 保持启用，Python 3.14.3 / Pillow 12.1.1 检查通过。

## 验证结果

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 合并后 Node 回归 | 150 通过，0 失败 | `qa/mc-skin-verification/merged-node-tests.txt` |
| 皮肤 Python 适配器 | 13 通过 | `python -B -m unittest discover -s tests -p test_mc_skin_adapter.py` |
| 原 Skill 用例 | 16 通过 | `python -B -m unittest discover -s integrations/minecraft-pixel-skin/tests -p 'test*.py'` |
| 来源快照 | 原 Skill 与副本的27文件 SHA256 一致 | `integrations/minecraft-pixel-skin/source-manifest.json` |
| 源码桌面流程 | 14 组通过，界面错误为空 | `qa/mc-skin-source-final/result.json` |
| 包内 MC 皮肤流程 | 14 组通过，实际 Python / WebGL | `qa/mc-skin-packaged-final/result.json` |
| 保留的绘图流程 | 8 组通过，界面错误为空 | `qa/mc-skin-preserved-drawing/result.json` |
| Windows 包 | 构建退出码0，运行端自检通过 | `dist-workbench/build-record.json`、`qa/mc-skin-verification/final-build-stdout.txt` |
| 正式程序启动 | 实际 EXE、窗口、健康接口、模块启用与环境检查通过 | `qa/mc-skin-verification/normal-start.json` |

皮肤流程覆盖：参考图与原皮肤上传、配置路径导入、两层与视角切换、64×64 展开图、全部涉及面的分层图、真实 PNG 下载、版本确认、继续修改、页面重载、明暗主题和125%缩放。390px 页面无横向溢出；窄屏截图只直接证明上方表单，没有声称已完成下方预览区的窄屏视觉验收。

异步检查实际延迟响应，覆盖提交成功但响应丢失后的幂等重试、刷新互斥后的状态补拉、上传期间新建草稿不会被旧响应回填、正常上传切页后继续保留。后台检查覆盖并发请求、取消后迟到的 AI 回复、异常重启中断且不重发 AI、角色快照与独立版本。

独立规格审查的问题已关闭；代码质量审查两项异步问题经原复现路径复核为 resolved；界面 finish review 的结论为 ship。没有覆盖或改变两种通用眼型的确认状态。

## 真实 AI

`qa/mc-skin-live/result.json` 记录了一次实际 Codex 调用。输入明确使用 `minecraft-pixel-skin` 与真实本地皮肤图，输出由 Python 适配器执行：只修改全图坐标 `[20,20]` 一格为指定颜色，其余4095格和源 PNG 保持不变，PNG 回读与校验通过。

这次真实调用验证制作链路及局部修改能力。完整桌面用例采用确定性 AI 夹具，并实际执行 Python、图片下载和 WebGL；它不等于任意角色的新作美术质量都已验收。OpenAI 兼容接口的视觉内容数组通过测试，没有向真实付费兼容服务发送验收请求。Minecraft 游戏内效果尚未验证。

## 与现有版本合并

发布时发现正在使用另一份已交付的 ComfyUI 工作台，保留其上传、按任务取消、图片归档等修复后再验收。来源为 `E:\AI-未来\ai-future-comfyui` 的已交付提交 `290a323`，绘图实现与其运行包逐文件一致；未混入该工作区随后正在编写的新检测用例。同步前的源文件保存在 `qa/mc-skin-comfy-preservation`，来源与哈希记在构建记录中。

原工作台数据仍位于 `%APPDATA%\AI-Future-Workbench\data`，正式皮肤作品数量在启动验收时为0，测试素材和任务均使用独立 QA 目录。升级前正常关闭窗口并等待草稿保存，旧程序保留在 `dist-workbench\backup-before-mc-skin-20261106-003321`。发布路径和正常启动证据见 `qa/mc-skin-verification/deployment.json`。
