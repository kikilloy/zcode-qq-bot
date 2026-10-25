# zcode-qqbot — QQ 私聊 ↔ zcode 桌面会话桥

把 **QQ 私聊（C2C）** 与**当前打开的 zcode 桌面会话**双向同步：手机 QQ 发的消息在回合间隙注入会话，模型用 `qq_reply` 工具回复到 QQ。会话上下文、MCP、已装插件全部原样可用——等于从手机遥控 zcode。

**形态是"会话桥"，不是常驻机器人**：网关内嵌在插件 MCP 服务器进程里，随会话生灭（ADR-0001）。

```
┌─ zcode 桌面会话 ─────────────────────────────────────┐
│   模型 ←→ MCP 工具 (qq_reply / qq_status / …)        │
│   钩子: UPS（终端镜像+空闲取信）、Stop（注入/自愈）   │
└───────┬──────────────────────────────────────────────┘
        │ stdio (MCP)              │ 127.0.0.1 HTTP（控制平面，端口随锁文件落盘）
┌───────▼──────────────────────────────────────────────┐
│ 网关（dist/mcp-server.mjs 进程内）                     │
│   QQ WS 连接 · 收件箱 · 被动回复账本 · 单实例锁 · 日志  │
└───────┬──────────────────────────────────────────────┘
        │ @tencent-connect/qqbot-nodejs
     QQ 开放平台
```

## 安装（本地 marketplace 自用）

1. 打开 ZCode → **插件市场 → 添加 → 添加插件市场**，粘贴本仓库根目录的绝对路径。
2. **个人 → QQ 会话桥（开发版）→ 安装**。
3. 改码后更新：`npm run build` + 递增版本号（`plugin.json` / `marketplace.json` 两处同步）→ 插件市场齿轮 → **刷新该市场** → 插件详情 → **更新** → **新开会话**生效（源码不热载）。

产物为 esbuild 单文件 `dist/*.mjs`（网关 + 两个钩子），运行时零 node_modules。

## 首次使用（按序）

1. 拿凭据，二选一（**全局保存一次即可，之后所有会话共用，无需重复配对**）：
   - `/qq-setup appId appSecret`——已有凭据（QQ 开放平台 q.qq.com 机器人详情页）时最快，免扫码；
   - `/qq-pair`——没有凭据时扫码配对，自动获取（命令会先问你是否已有凭据）。
2. `/qq-bind`——双确认绑定你的 QQ 号（先发条私聊 → 模型展示 openid → 你口头同意 → 写白名单）。
3. 连接默认自动（`autoConnect` 开）：配好凭据后每个新会话打开即连。想换到当前会话？直接 `/qq-connect`——**连接即接管**，会自动请原持锁会话让位，不用去找是哪个对话占着。
4. 手机 QQ 给机器人发消息：**回合进行中**到达 → 回合结束的 Stop 钩子注入；**会话空闲时**到达 → 随你在 zcode 里提交的下一条**普通文字**（斜杠命令不触发）一起进入会话；空闲 8 秒无人取会弹桌面通知 + QQ 回执提醒。格式都是 `[QQ] <内容>（来自 …）`，模型干活并用 `qq_reply` 回复。

## 命令（8 个）

| 命令 | 作用 |
|---|---|
| `/qq-pair` | 扫码配对，自动获取凭据（已有凭据会先提示改走 /qq-setup） |
| `/qq-setup appId appSecret` | 直接填凭据，免扫码（缺参数则询问） |
| `/qq-connect` / `/qq-disconnect` | 连接（被占用时自动接管）/ 断开（释放锁） |
| `/qq-bind` | 双确认绑定 QQ 号 |
| `/qq-watch on\|off` | 开/关值守模式（qq_wait 常驻循环，见下） |
| `/qq-status` | 全状态：连接/白名单/配额/收件箱/值守/镜像开关 |
| `/qq-mirror on\|off` | 终端镜像开关（默认关，开启后有界面提示） |

另有 `skills/qq-bridge`：模型看到 `[QQ]` 标记时自动遵守收发约定。

## 行为与取舍

- **值守模式（v2，/qq-watch on）**：模型调用 `qq_wait` 工具挂起等待来信（单次最长 30 分钟到点自动续），来信即到即处理即回复——空闲期零模型调用、无需本地交互带出。`qq_wait` 被取消/断线时安全返回，收件箱不动；值守中回合意外结束由 Stop 钩子兜底拉回循环。
- **图片与表情（0.4.2）**：商城大表情解码为可读描述（QQ 平台只下发 ID）；图片/GIF 附件自动下载到 `~/.zcode/qqbot/media/` 并把本地路径注入会话，模型可直接看图。
- **注入时机**：QQ 消息入收件箱后走两条路——回合进行中到达，回合结束的 **Stop 钩子**注入（不打断进行中的回合，每回合链最多合并 3 条）；会话空闲时到达，随用户**下一次提交的提示词**一起注入（UserPromptSubmit 钩子 additionalContext；**斜杠命令不触发**，要普通文字）。未开值守时空闲会话无法被主动唤醒；值守模式（qq_wait）即为此而生。
- **空闲通知兜底**：消息入箱 8 秒无人取 → Windows 弹通知"QQ 消息待取：…"，同时 QQ 端自动回执"已收到，回到电脑随便输入一句即可处理"（各 60 秒冷却；`qq_config` 可关 idleNotify / idleAck）。消息本体保留在收件箱，随时可取。
- **自愈**：QQ 驱动的回合若忘调 `qq_reply`，Stop 钩子提醒模型补发；每刺激至多 1 次，防死循环。
- **被动回复配额**：QQ 限制每封来信 60 分钟内被动回复 4 条——`qq_reply` 被动优先、耗尽自动降级主动消息，余量随工具返回值可见。
- **超长自动分片**：默认 4500 字/片（平台上限约 5000）。
- **单实例锁 + 连接即接管**：同时只有一个会话连 QQ（锁文件 `~/.zcode/qqbot/lock.json`，含 pid/port/sessionId/占用起始时间/工作目录）。任何会话里 `/qq-connect` 都会请当前持锁会话经其控制平面让位并接管——桥跟着最后手动连接的会话走；autoConnect 启动连接不抢活锁。让位过程中的瞬间来信可能丢失（秒级窗口）。
- **终端镜像默认关**：开启后（`/qq-mirror on`）你在 zcode 输入的每条提示词以 `🖥 终端` 前缀发到 QQ（斜杠命令除外），且开启时界面有明确提示。
- **安全**：appSecret 只落 `~/.zcode/qqbot/config.json`（0600），绝不进日志/userConfig；白名单外 QQ 号的消息直接丢弃。
- **钩子必须便宜**：无锁文件或网关不可达时钩子立即空输出退出，不做任何网络请求。

## 配置与运行时文件

`~/.zcode/qqbot/`（均可用环境变量 `ZCODE_QQBOT_CONFIG/STATE/LOCK/LOG` 覆盖，另有 `ZCODE_QQBOT_SDK` 供测试注入假 SDK）：

- `config.json`——appId/appSecret、allowFrom（白名单）、maxChunkChars(500-4800)、forwardTerminal、selfHeal、autoConnect、idleNotify/idleAck（空闲通知）、allowGroup(仅 v2)
- `state.json`——最后回复目标（重启后恢复被动回复窗口）
- `lock.json`——单实例锁
- `log.jsonl`——结构化日志（2MB 轮转，不含敏感值）

## 开发

```bash
cd zcode-qqbot
npm run build   # esbuild 三个入口 → dist/
npm test        # 52 单测 + flow-harness + hook-harness（钩子端到端）
npm run smoke   # dist MCP 握手冒烟
npm run e2e     # 跨进程 bundle 端到端（真 mcp-server 进程 × 真钩子进程）
```

测试分层：纯逻辑单测 → fake-SDK 流程 harness → 钩子/决策矩阵 harness → bundle 冒烟/E2E → 真机手动冒烟。

## 仓库导航

| 路径 | 内容 |
|---|---|
| [zcode-qqbot/](zcode-qqbot/) | 插件交付物（源码/构建/测试） |
| [docs/design.md](docs/design.md) | 设计规格：架构、MCP 工具面、钩子行为、配置、测试、风险 |
| [CONTEXT.md](CONTEXT.md) | 领域术语表 |
| [docs/adr/](docs/adr/) | 架构决策记录（会话桥形态、Stop 续跑注入、SDK 选型、控制平面） |
| [probe/](probe/) | 平台机制探针实验记录（V0 证据链存档） |

## v2 路线图

**值守模式（已落地，0.4.0+）**——`/qq-watch` 开启会话内值守循环：`qq_wait` 工具阻塞等待（经工具 `_meta.timeoutMs` 声明 30 分钟上限）、来信即处理即回复、Stop 钩子兜底防漂移。（机制证据链与真机记录档仅本地保存，未入库。）
其余候选：QQ 按钮审批权限请求（杀手级）· 群聊 @ · typing/工具轨迹 · Markdown · 富媒体发送。见 [docs/design.md](docs/design.md) §10。
