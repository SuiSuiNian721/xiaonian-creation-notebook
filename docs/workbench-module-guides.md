# 模块使用说明与引导

分支：`feat/module-usage-guides`，基于 `main` 的 `650056e`。当前范围仅桌面端。

## 使用方式

九个模块的标题右侧都有「使用说明」，位于「AI 接入」左侧。每模块有六步引导；首次进入自动显示，可上一步、下一步、跳过或按 Esc 关闭。说明里的「开始引导」随时重播。

首次显示就记为已见，避免跳过后反复弹出。记录保存在当前工作台数据目录的 SQLite `moduleGuides` 设置中，独立于主题、模块配置和角色资料。重启或移除再添加模块保留记录，不依赖本地服务端口。保存失败会提示，当前会话不重复弹出。

引导只展示操作位置，不自动填写配置、连接账号、发送消息或执行生成任务。未显示的功能优先定位其页签入口；目标消失时保留下一步和关闭操作。切换模块会清理浮层，切换页签、滚动、缩放会重新定位。

## 维护位置

- `public-workbench/module-guides.js`：九模块文案、说明章节和按优先级排列的真实目标选择器。正文使用纯文本，不执行步骤回调。
- `public-workbench/module-help.js`、`module-help.css`：说明窗口、非模态高亮引导、定位、键盘和焦点恢复。
- `public-workbench/app.js`：模块成功加载并刷新状态后统一挂接，随当前页面 AbortSignal 清理。角色卡编辑器保持原实例。
- `framework/store.mjs`、`server.mjs`：`state.moduleGuides` 与 `POST /api/module-guides/:id`，仅接受已登记模块和空对象。
- `framework/card-studio-embed.mjs`：编辑器 iframe 的 Esc 先交给引导，再交给沉浸快捷键。
- `public-workbench/modules/companion.js`：说明/引导显示时收起原生视图，关闭后恢复；进入沉浸模式收起引导。

## 验证

- `node --test tests/module-guides.test.mjs tests/module-help-ui.test.mjs`：真实 HTTP 持久化与九模块 Electron DOM 验收。
- `tests/module-guides.test.mjs` 覆盖重开数据库及更换端口、按模块隔离、主题隔离、停用再启用、输入及来源校验。
- `tests/module-help-ui.test.mjs` 覆盖全部 54 步真实目标、首次/重播/跳过/Esc、返回步骤、说明位置、导航清理、普通折叠区、切换实际页签后重新定位、未保存表单、焦点恢复、桌面窗口边界。Electron 使用独立临时 profile。
- `tools/qa-companion.mjs`：原生桌面 16 组通过，同一测试数据目录重跑通过；验证陪伴原生视图显隐、编辑器 iframe 焦点 Esc、沉浸操作以及正文/聊天草稿保持。聊天服务使用本机模拟响应。
- 截图：`qa/module-guides-ui/`（1440×1000 浅/深主题、1100×800 桌面）；原生报告：`qa/module-guides-native/result.json`。

新 worktree 的 MC 测试依赖不在 Git 中，本机通过目录联接复用主项目 `integrations/airi-minecraft/node_modules`；未修改 MC 业务代码或跳过失败用例。完整回归报告位于 `qa/module-guides-ui/unit-all-final.log`。

最终完整回归共 434 项：430 通过、4 项原有环境条件跳过、0 失败。最后补充目标消失场景后，持久化及实际模块引导验收 8/8 再次通过。独立规范与代码复核发现的折叠区事件、iframe Esc 和错误提示文案问题均已修复；浅色引导截图已重新捕获并实际查看。

## 预览

独立预览资料位于 `artifacts/module-guides-preview-profile`，窗口标题带「引导预览」，从角色绘图的首次引导开始。保留现有工作台窗口及其资料。当前交付为分支源码预览，发布 EXE 尚未重新打包。
