# zcode-qq-bot

把 QQ 私聊桥接到当前正在运行的 zcode 桌面会话的插件项目。作者此前在另一套 AI 编程助手上验证过同样的桥接思路（本地存档，未入库）；zcode 没有进程内扩展 API，本项目的桥接机制围绕 zcode 的 MCP 服务器与钩子重新构建。

## Language

### 产品形态

**会话桥 (Session Bridge)**:
本插件的形态：QQ 私聊与当前打开的 zcode 桌面会话双向同步。zcode 未运行时 QQ 侧只排队，不产生回复。
_Avoid_: 机器人模式、常驻机器人（那是 OpenClaw 类产品的形态，本项目明确不做）

**传输层 (Transport)**:
持有 QQ WebSocket 连接、收件箱、发件箱与被动配额账本的部分，与 zcode 无关，未来可独立成常驻进程。
_Avoid_: SDK 层、连接层

**桥接层 (Bridge)**:
把传输层接到 zcode 上的部分：MCP 工具、钩子脚本、命令与技能提示词。
_Avoid_: 插件层、胶水层

**网关 (Gateway)**:
传输层的运行实例。v1 中由 MCP 服务器进程承担，整个会话期存活；同一时刻只有一个网关持有 QQ 连接（锁保证）。

**控制平面 (Control Plane)**:
网关在 `127.0.0.1` 暴露的本地 HTTP 接口，供钩子脚本等短命进程查询收件箱、上报事件。钩子与 MCP 服务器是不同进程，这是它们之间唯一的通道。

### 消息流

**收件箱 (Inbox)**:
网关里排队等待注入会话的 QQ 消息队列。

**注入 (Injection)**:
把一条 QQ 消息作为带 QQ 标记的用户上下文送进 zcode 会话的动作，经 Stop 钩子续跑实现。

**回合 (Turn)**:
一次 agent 响应周期，以 Stop 事件收尾。收件箱只在回合之间被清空——QQ 消息不能打断进行中的回合。

**续跑 (Continuation)**:
Stop 钩子返回 JSON 请求 agent 携带上文继续工作的平台机制（每用户回合链至多 3 次，M0 实测，见 ADR-0002）。注入与自愈都建立在它上面。

**自愈 (Self-heal)**:
QQ 驱动的回合结束时，若模型没有调用 qq_reply 把回复发往 QQ，Stop 钩子请求续跑提醒它补发。

**QQ 标记 (QQ Marker)**:
注入消息前加的 `[QQ]` 前缀，用于识别消息来自 QQ，防止把 QQ 来的回声再发回 QQ。
_Avoid_: 注入标签、水印

**终端镜像 (Terminal Mirror)**:
把用户在 zcode 桌面里输入的提示词经 UserPromptSubmit 钩子转发到 QQ（带 🖥 终端 前缀）。默认关闭。

### QQ 平台概念

**被动回复 (Passive Reply)**:
携带来信 msg_id 的回复。C2C 每条来信限 4 次 / 60 分钟，群聊 5 次 / 5 分钟，超出即失效。

**主动消息 (Proactive Message)**:
不带 msg_id 的自发消息。受平台主动消息额度限制，可能被拦截，只作被动额度耗尽时的降级路径。

**白名单 (allowFrom)**:
允许驱动会话的 QQ openid 列表。空列表 = 只有绑定可用。

**绑定 (Binding)**:
把一条 QQ 私聊来信的 openid 确认为唯一白名单用户的流程。经会话内二次确认后写入配置。

**配对 (Pairing)**:
用手机 QQ 扫二维码换取 AppID/AppSecret 的初始化流程（官方 qqbot-connector），替代手动填凭据。
