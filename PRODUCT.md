# AI-未来 · 角色工作台

<!-- impeccable:product-schema 1 -->

## Platform

web

界面运行于 Windows Electron 桌面应用；后续扩展手机客户端。

## Stack

沿用 AIRI 的 Electron 技术路线。本地常驻 Node.js 服务提供会话、存储和 QQ 接口；管理界面使用原生 HTML/CSS/JavaScript，降低首版依赖。

## Users

念念与希望完善虚拟角色的创作者，需要在本机配置角色，体验对话，并核对聊天、记忆和服务状态。

## Product Purpose

以同一个角色为中心连接形象、聊天、声音和 QQ 日常交流。第一版交付可运行 Windows Demo。

## Operating Context

复用本机 AIRI 0.12.0-beta.5 的舞台资源作为本地兼容接入；现有 AIRI 安装、QQ 实例和私人数据保持独立。新 Demo 有自己的数据目录与端口。

## Capabilities and Constraints

- 角色聊天、会话历史、显式保存的记忆、运行记录、服务配置。
- QQ 默认未连接，通过明确配置连接；模拟消息有清楚的沙盒标记。
- 语音调用生成音频，不自动播放；真实 QQ、音色与口型单独验收。
- 模型未配置时提供明确标注的离线演示回复，不伪装成模型响应。
- 首版面向本地单用户；不开放公网，不内嵌其他应用密钥。

## Brand Commitments

名称 AI-未来；简体中文；尊重创作者对角色性格和表达的决定。

## Product Principles

- 同一个角色，多种交流入口。
- 展示实际状态，区分生成、合成与发送结果。
- 用户可查看并纠正记忆。
- 能力可以独立使用，原有项目不被覆盖。
