---
name: AI-未来 Aurora
description: 参考 Auroraqua 的冰态果冻角色工作台
colors:
  aurora-blush: '#fff0f5'
  aurora-peach: '#ffe4e1'
  aurora-lavender: '#e6e6fa'
  plum-ink: '#342748'
  deep-plum: '#30203f'
  muted-plum: '#6c5c7c'
  rose-accent: '#a84893'
  violet-accent: '#8554b8'
  night-blue: '#142136'
  night-slate: '#28304c'
  night-plum: '#332747'
  moon-ink: '#ece4f4'
typography:
  headline:
    fontFamily: Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, sans-serif
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, sans-serif
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.8
  label:
    fontFamily: Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, sans-serif
    fontSize: 13px
    fontWeight: 500
rounded:
  panel: 26px
  control: 14px
  bubble: 20px
spacing:
  panel-gap: 20px
  canvas-inset: 24px
components:
  button-primary:
    color: '#ffffff'
    borderRadius: '{rounded.control}'
  glass-panel:
    borderRadius: '{rounded.panel}'
---

# AI-未来 Aurora 设计系统

## 方向

以「冰态果冻」为指定视觉方向：粉桃与薰衣草紫的极光底色，独立漂浮的半透明面板，柔和外扩阴影、细白边缘高光和圆润控件。依据念念指定的 Auroraqua-UI 聊天页、组件及深色截图重新实现，不继承被否定的旧版视觉体系。

这是 Windows 上日常使用的角色工作台。视觉承载陪伴感，操作保持清楚：会话是入口，对话是中心，右侧呈现角色摘要；设定编辑和服务接入拥有各自的页面。旧界面三文件保持不变，旧 DESIGN 位于 `docs/archive/ui-v0.1`。

## 颜色与材质

浅色渐变由 `aurora-blush`、`aurora-peach`、`aurora-lavender` 组成，正文使用深紫墨色。深色从 `night-blue` 过渡到 `night-plum`，面板为蓝灰玻璃，文字使用月白色。主题由 profile 内 SQLite 保存，不依赖桌面随机端口的浏览器存储。

面板使用白色 34% 的半透明填充、24px 背景模糊和 70% 白色边缘高光；深色对应蓝灰填充与低强度边缘。阴影为 `0 18px 48px rgb(93 60 123 / 15%)`，辅以顶部内高光。背景与面板间必须有空间，避免重新连成铺满屏幕的平面表格。

用户气泡和主按钮使用 `#ad438c → #8754bb`，以足够深的颜色承载白字。助手气泡为半透明白，头像以粉紫和青蓝区分双方。成功、提醒和错误都配合文字，不只依赖颜色。

## 字体

使用 Windows 的 Segoe UI Variable Text 和 Microsoft YaHei UI 系统字族，保证中文界面可读；未复制参考仓库附带的字体。正文以 15px 为基准，手机不低于 14px；辅助文字至少 12px。消息正文使用充足行高和有限行宽。品牌与角色名依靠字号、字重形成层次，不做渐变文字。

## 布局与形状

桌面网格为 `276px / minmax(0, 1fr) / 272px`，外留白 24px、面板间距 20px。1360px 以下稍收窄两侧；1200px 以下角色栏成为可关闭浮层；760px 以下左侧只保留窄导航和新建入口，通过下拉切换会话，表单单列，连接类别以两列排列。聊天滚动区域与胶囊输入区独立。

面板圆角 26px，控件 14px，气泡 20px。胶囊只用于聊天输入和小型状态控件。所有按钮提供焦点、按压、禁用、请求中和错误恢复状态；滚动条、文字选中与输入光标使用本主题的紫色系。

## 动效

背景进行低幅度的 28 秒漂移；按钮在 180ms 内完成轻微按压与回弹。动态效果从可见状态开始，遵循 `prefers-reduced-motion`。不在每次后台轮询时重播整屏入场动画。

## 页面和状态

- 聊天保留真实的离线演示、模型回复与 QQ 投递标记；没有装饰性的假聊天、在线人数或统计。
- 角色设定独立编辑，右侧只保留简介与能力概览。
- 连接使用模型、声音、QQ 与沙盒四个分段页；保存配置与建立连接分开。
- 记忆默认当前会话，角色共用须明确选择；从消息保存时固定来源。慢请求返回不能清空新输入的草稿。
- 语音只生成并保存，等待用户主动播放。QQ 沙盒不触发真实发送。
- 舞台保留 AIRI 的真实渲染与示例形象标记，不将未同步的人设、声音和模型描述为已绑定。

## 实现边界

全新前端位于 `public-aurora`，旧 `public` 保留。参考为 micromimo/Auroraqua-UI 的 `456e6e0e13ba26233bff30cade20a0bb889e28c0`。本次自行编写结构、样式和控制器，不复制上游组件源码、人物素材或字体。
