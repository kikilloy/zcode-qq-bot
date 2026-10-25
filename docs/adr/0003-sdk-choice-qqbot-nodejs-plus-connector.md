# 传输 SDK 用 @tencent-connect/qqbot-nodejs + qqbot-connector

传输层选 npm 包 `@tencent-connect/qqbot-nodejs`（v1.0.x，活跃维护，支持 C2C/群聊/富媒体/流式/typing），配对用同厂 `@tencent-connect/qqbot-connector`（扫码即得 AppID/AppSecret）。这个组合是 QQ 官方 OpenClaw 频道插件（`@tencent-connect/openclaw-qqbot`）的同款依赖，等于官方背书；平台怪癖（被动配额 C2C 4条/60分钟、群聊 5条/5分钟、msg_id 失效等）已在本项目前身原型中全部实测趟平。

## Considered Options

- **sdk-py（botpy）**：功能齐全但要求 Python 环境，与 zcode 插件的 Node 宿主栈不符。仅作 msg_id/msg_seq 语义对照。
- **sdk-nodejs（qq-guild-bot 2.9.4，用户 clone 的 Node SDK）**：2022 年冻结的纯频道 SDK，不支持 C2C/群聊，不可用。
- **connector 的 UNLICENSED 许可**：无明确再分发授权，个人插件自用可接受；若未来公开发布，需降级为手动填凭据或征得官方同意。
