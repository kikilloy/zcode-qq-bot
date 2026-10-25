# zcode-qqbot 设计文档

> 状态：设计定稿（2026-10-24），未开工。术语见 [CONTEXT.md](../CONTEXT.md)，架构决策见 [docs/adr/](adr/)。
> 前身：作者在另一套 AI 编程助手上的同类桥接原型（本地存档，未入库）；本设计把已验证的平台行为与状态机重建到 zcode 的插件模型（MCP + 钩子 + 命令/技能提示词）上。

## 0. 目标与非目标

**目标（v1）**
- QQ 私聊（C2C）↔ 当前打开的 zcode 桌面会话双向同步。
- 官方扫码配对（手机 QQ 扫码即得 AppID/AppSecret），手动填凭据作兜底。
- 被动回复配额记账 + 主动消息降级、超长分片、白名单/绑定、单实例锁。
- 五加一命令：`/qq-pair` `/qq-setup` `/qq-bind` `/qq-connect` `/qq-disconnect` `/qq-status`，另有 `/qq-mirror`（终端镜像开关）。
- 插件通过本地 marketplace 安装自用。

**非目标（v1 明确不做）**
- 常驻机器人 / headless 会话（zcode 无 headless CLI，见 ADR-0001）。
- QQ 消息中途打断进行中的回合（只能回合间排队）。
- assistant 中间消息流式输出（zcode 无 assistant 事件；本桥出站设计本就是每回合一条，无损失）。
- 群聊、typing 提示、工具轨迹、Markdown、富媒体（v2+，见 §10）。

**产品动机**：从手机 QQ 遥控正在使用的 zcode 会话，用于体验 zcode 的各种 token 套餐——会话上下文、MCP、已装插件全部原样可用。

## 1. 总体架构

```
┌─ zcode 桌面会话 ─────────────────────────────────────┐
│   模型 ←→ MCP 工具 (qq_status / qq_reply / …)        │
│   钩子: UserPromptSubmit、Stop（node 短命进程）        │
└───────┬──────────────────────────┬──────────────────┘
        │ stdio (MCP)              │ 127.0.0.1 HTTP（控制平面）
┌───────▼──────────────────────────▼──────────────────┐
│ 网关（传输层，MCP 服务器进程内嵌）                      │
│   QQ WS 连接 · 收件箱 · 配额账本 · 锁 · 状态/日志      │
└───────┬─────────────────────────────────────────────┘
        │ @tencent-connect/qqbot-nodejs（WebSocket 网关）
     QQ 开放平台
```

- **分层**（ADR-0001）：传输层不 import 任何 zcode 概念；桥接层（MCP 工具 + 钩子脚本）只跟网关的控制平面与 MCP 接口打交道。未来常驻形态 = 传输层独立成守护进程 + 插件 manifest 改指 http MCP，桥接层不变。
- **网关**：随会话启动的 stdio MCP 服务器进程，整个会话期存活。QQ WS 连接**懒建立**（`/qq-connect` 或 `autoConnect: true` 时才连）。
- **单实例锁**（文件锁 + 持锁者元数据模式）：锁文件记录持锁网关的 `{pid, host, port, sessionId, at}`。同时只有一个会话的网关真正连 QQ；其余会话的网关待机，其钩子空转即退。
- **控制平面**（ADR-0004）：网关监听 `127.0.0.1:<随机端口>`，端口随锁文件落盘。钩子脚本（独立短命进程）靠它查收件箱、上报终端输入。只绑回环，凭据不出网关。

## 2. 插件组成

```
zcode-qqbot/
├── .zcode-plugin/plugin.json     # manifest
├── package.json                  # devDeps: esbuild, @types/node；scripts: build/test
├── tsconfig.json
├── src/
│   ├── core.ts                   # 平台配额与分片核心：ReplyBudget/chunkText/markInjected/isInjected
│   │                             #   （去掉 Debouncer——v1 无中间消息流式，出站每回合一条）
│   ├── config.ts                 # 配置加载/校验/写入（0600），字段见 §6
│   ├── state.ts                  # 最后目标持久化（scope/targetId/msgId），重启恢复被动窗口
│   ├── lock.ts                   # 网关锁 + 端口落盘
│   ├── log.ts                    # logLine 结构化 JSONL 日志
│   ├── gateway.ts                # 传输层：QQBot 包装、鉴权/去重/收件箱/配额/绑定态
│   ├── control-plane.ts          # 127.0.0.1 HTTP：/health /claim /terminal-mirror
│   ├── continuation.ts           # Stop 续跑 JSON 契约（隔离探针结论，schema 变化只改这里）
│   ├── mcp-server.ts             # 入口：MCP stdio + 内嵌网关 + 控制平面
│   ├── hook-stop.mts             # Stop 钩子入口（打包为 dist/hook-stop.mjs）
│   └── hook-user-prompt-submit.mts
├── dist/                         # esbuild 单文件产物（提交进插件，无 node_modules）
├── commands/                     # qq-pair / qq-setup / qq-bind / qq-connect / qq-disconnect / qq-status / qq-mirror
├── hooks/hooks.json
└── skills/qq-bridge/SKILL.md     # 教模型：[QQ] 标记含义、qq_reply 约定
```

**manifest 要点**（`.zcode-plugin/plugin.json`）：

```json
{
  "name": "zcode-qqbot",
  "version": "0.2.1",
  "description": "把 QQ 私聊桥接到当前 zcode 会话",
  "mcpServers": {
    "qqbot": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.mjs"]
    }
  },
  "hooks": "./hooks/hooks.json",
  "commands": "./commands",
  "skills": "./skills"
}
```

> ⚠️ **不要在 mcpServers.env 里用会话变量**（2026-10-25 事故）：`${CLAUDE_SESSION_ID}` 等只在钩子层可展开；mcpServers 的 env/command/args 走插件加载层 `cE()`，遇到会话变量直接抛 `Plugin variable requires a runtime session context` → **整个 MCP 服务器被丢弃**（命令/技能不受影响，极具迷惑性）。会话 id 由网关 `detectSessionId()` 从 `process.env.CLAUDE_SESSION_ID / ZCODE_SESSION_ID` 兜底探测（MCP 子进程是否继承该 env 待运行时观察，bootstrap 日志会记录探测结果；缺失时 claim/mirror 的会话守卫退化为宽松——单实例锁下仍正确）。

**hooks.json 要点**：`UserPromptSubmit` 与 `Stop` 各挂一个 `type: "process"` 钩子（`node ${CLAUDE_PLUGIN_ROOT}/dist/hook-*.mjs`，`timeoutMs` ≤ 15000）。不用 shell，跨平台安全。

## 3. MCP 工具面（桥接层 API）

| 工具 | 作用 | 备注 |
|---|---|---|
| `qq_status` | 连接/锁/白名单/目标/配额余量/最近错误/配对与绑定待办 | 全状态只读 |
| `qq_connect` | 连接 QQ 网关（抢锁） | 已被占用时报持锁 pid/host |
| `qq_disconnect` | 断开并释放锁 | |
| `qq_setup {appId, appSecret}` | 手动写凭据并保存 | 兜底路径 |
| `qq_pair_start` | 发起扫码配对，返回二维码（终端 ASCII + URL） | connector 在网关内跑；返回 `pairingId` |
| `qq_pair_pending {pairingId, timeoutSec≤120}` | 长轮询扫码配对结果 | M3 实测 connector 后补充：扫码异步到，凭据成功即写 config |
| `qq_config {patch}` | 受控写配置（allowFrom/forwardTerminal/autoConnect/maxChunkChars/selfHeal…） | appSecret 也可写；改后需重连 |
| `qq_bind_start` | 进入绑定态（下一条私聊来信进待确认，不入收件箱） | |
| `qq_bind_pending {timeoutSec≤60}` | 长轮询待确认 openid | 让模型取到 openid 后向用户展示 |
| `qq_bind_confirm {openid}` | 双确认第二步：写入 allowFrom | 模型必须在用户口头同意后才调用 |
| `qq_reply {text}` | 向当前目标发文本：分片→被动优先→配额记账→耗尽降级主动 | 出站主力；返回 remaining/warn |

## 4. 钩子行为

**UserPromptSubmit**（终端镜像 + 空闲取信；0.3.0 扩展）
1. stdin 读事件 JSON，取 prompt 文本与 sessionId。
2. POST 控制平面 `/terminal-mirror {text, sessionId}`。
3. 网关若已连接、已开镜像、且 sessionId 匹配持锁网关 → 以 `🖥 终端` 前缀发 QQ（被动优先）。斜杠命令（`/` 开头）不镜像。
4. **取信注入（0.3.0 主修，真机复盘发现：会话空闲时没有 Stop 事件，空闲期到达的来信会滞留收件箱直到手动断开）**：POST `/claim {sessionId, via:"ups"}`，决策矩阵与 Stop 完全同一套；取到信输出 `{"additionalContext": reason}`——zcode.cjs 实证（zPr schema + Hvo/Qma 消费逻辑）：**顶层 additionalContext 键对所有事件无条件注入，与 hookSpecificOutput 双写会重复注入**，只用顶层键。空收件箱/无刺激 → 不写 stdout。**斜杠命令不触发本钩子**（0.3.2 真机双证：普通输入 07:22:17 有 ups claim、/qq-connect 07:22:38 只有 stop）——"随便输一条"必须普通文字。
5. **顺序约束：先镜像后取信**。mirror 无条件清自愈刺激，claim 注入要重新立起刺激；顺序反了刚立的刺激会被 mirror 清掉，模型忘回复时 Stop 不再自愈。
6. **界面提示**（Q1 定案：默认关、手动开启、有提示）：
   - QQ 侧：每条镜像消息带 `🖥 终端` 前缀，持续可见；
   - 桌面侧：`/qq-mirror on` 的命令提示词要求模型开启后立即 notify「终端镜像已开启：你在 zcode 里输入的每条提示词都会发往 QQ」；
   - `qq_status` 常驻展示 `forwardTerminal` 当前值。

**Stop**（注入与自愈的主通道，ADR-0002；契约已由 M0 源码考古定案，见 ADR-0002「实测」一节；0.3.0 起空闲取信由 UserPromptSubmit 分担）
1. POST `/claim {sessionId}`；网关决策矩阵：

| 条件 | 动作 |
|---|---|
| 本回合由 QQ 驱动（最近刺激是注入）且未见 `qq_reply`，且本回合自愈未用过（stdin `stop_hook_active` 可辅助判断） | 返回**自愈续跑**：reason =「[QQ 桥] 请调用 qq_reply 把上面的回复发给 QQ」（每回合至多 1 次，防死循环） |
| 否则收件箱非空 | 取最多 N 条（**N=3，M0 实测上限：每用户回合链至多 3 次注入续跑**），逐条标记注入（记 lastInjectAt），返回**注入续跑**：reason =「[QQ] <内容>（来自 openid …，时间 …）」，多条合并为一块上下文 |
| 否则 | 输出空 JSON（正常收尾） |

2. 续跑 JSON 契约（收在 `continuation.ts`）：**`{"decision":"block","reason":...}`** 为注入主形态——reason 既触发续跑又成为注入内容；`{"continue":true,"additionalContext":...}`（官方邮箱同款）为备选；**裸 `{"continue":true}` 不续跑**（additionalContexts 必须非空）。输出为严格白名单 9 键，多余键判失败。注入合并为一条 `hook_context` 消息，截断 24000 字符（maxChunkChars 4500 下安全）。
3. 无网关（锁文件不存在/进程已死）时钩子立即静默退出——**每个回合结束都会 spawn 一次 node，必须便宜**：无 `ZCODE_QQBOT_LOCK` 可读或 /health 不通 → 直接 exit 0。
4. stdin 关键字段（M0 确认）：`session_id` / `last_assistant_message` / `stop_hook_active` / `transcript_path`（临时文件，仅含本回合回复预览）；`CLAUDE_SESSION_ID` 等同时以 env 与 argv 模板注入。

## 5. 消息流（时序）

- **QQ → 会话**：来信 → 白名单/绑定态鉴权 → messageId 去重（seen 上限 500）→ 记 replyTarget（scope/targetId/msgId，持久化到 state.json）→ 入收件箱 → 回合结束 Stop 取走（decision:block 续跑注入）；**会话空闲时由 UserPromptSubmit 取走（additionalContext 随提示词注入，0.3.0）**。插件无法主动唤醒空闲会话——空闲期来信需一次本地交互带出；**8 秒无人取则网关弹 Windows 通知 + QQ 被动回执提醒（0.3.2，各 60s 冷却，idleNotify/idleAck 可关）**。
- **会话 → QQ**：模型 `qq_reply(text)` → `chunkText(4500)` 分片 → 每片查 `ReplyBudget`（C2C 4 条/60 分钟）→ 有余量走被动（带 msg_id）→ 耗尽降级主动（不带）→ 记账 → 返回余量给模型转述；桌面侧在余量 ≤1 / 耗尽时经 `qq_reply` 返回值提示模型告知用户。
- **配对**：`/qq-pair` → `qq_pair_start` → connector 弹出二维码（工具返回 ASCII + URL，模型展示）→ 手机 QQ 扫码 → 凭据自动回传 → 写 config.json → 模型提示直接 `/qq-connect`。connector API 以包内 d.ts 实测为准；不可用则退化 `/qq-setup` 手动凭据（ADR-0003）。
- **绑定**：`/qq-bind` → `qq_bind_start` → 用户用 QQ 私聊发任意消息 → `qq_bind_pending` 取到 openid → 模型在会话里展示并请用户确认 → 用户同意 → `qq_bind_confirm` 写 allowFrom（双确认）。
- **换会话接管（0.3.1）**：会话 B `qq_connect` 时锁被会话 A 持有 → B 经 A 的控制平面 `GET /health`（pid 与锁同源，防误伤）探活 → `POST /shutdown` 请 A 让位（先回 200 再断开，A 的进程继续存活服务其会话）→ 400ms 后 B 重试抢锁接管。autoConnect 启动连接不接管（不抢活锁）——桥跟着**最后手动连接**的会话走。让位瞬间（秒级窗口）的来信可能丢失。锁文件带 `cwd` 与 `at` 作"是哪个对话"的线索。

## 6. 配置与运行时文件

`~/.zcode/qqbot/config.json`（0600；环境变量 `ZCODE_QQBOT_CONFIG/LOG/STATE/LOCK` 可覆盖各路径）：

```json
{
  "appId": "",              // 配对自动写入或 /qq-setup 手填
  "appSecret": "",
  "allowFrom": [],          // 空 = 只能绑定
  "markdownSupport": false, // v1 不发 Markdown，字段预留
  "allowGroup": false,      // v1 不启用群聊
  "autoConnect": true,     // 0.3.0 起默认 true（用户 2026-10-25：跨会话免手动连）；0.2.x 旧文件经 configVersion 迁移
  "configVersion": 1,      // 迁移标记：无此键的旧文件 autoConnect 翻成 true，之后显式改动不再被迁
  "maxChunkChars": 4500,
  "forwardTerminal": false, // Q1 定案：默认关，手动开启，界面有提示
  "selfHeal": true,         // 忘调 qq_reply 时的续跑提醒开关
  "idleNotify": true,       // 0.3.2：空闲消息桌面通知
  "idleAck": true           // 0.3.2：空闲消息 QQ 回执
}
```

中间消息的 debounce / 流式插播不实现（v1 无中间消息，出站天然每回合一条）。

运行时文件（`~/.zcode/qqbot/`）：`config.json` · `state.json`（最后目标）· `lock.json`（`{pid, host, port, sessionId, at}`，钩子靠 port 找到持锁网关）· `log.jsonl`（结构化日志）。

## 7. 构建、安装、验证

- **构建**：`npm run build` = esbuild 把 `mcp-server.ts`、两个 hook 入口各打成单文件 `.mjs`（platform=node, format=esm, bundle, external 无）。运行时依赖（qqbot-nodejs / qqbot-connector / qrcode）全部进 bundle，插件目录无 node_modules。
- **安装**：仓库根 `marketplace.json`（`{name:"zcode-qqbot-dev", plugins:[{name:"zcode-qqbot", source:"./zcode-qqbot", …}]}`）→ ZCode UI：Plugin Marketplace → Add 本地目录 → 安装。改码后手动 Update（不热载）。
- **测试**（分层策略）：
  - 纯逻辑单测（`node --test`）：budget / chunk / marker / config 校验；
  - fake-sdk 流程 harness：鉴权、去重、配额降级、锁互斥、绑定态；
  - Stop 决策矩阵 harness：注入 / 自愈 / 两者 / 无，四象限；
  - UserPromptSubmit 取信 harness（0.3.0）：空闲来信随提示词 additionalContext 注入 + 先镜像后取信的自愈顺序语义；
  - bundle-e2e 增补：跨进程空闲来信 → UPS additionalContext → 回复后 Stop 放行；双进程接管（server2 qq_connect 让位 server1 → 锁换主 → 原网关下线存活）；
  - 手动冒烟清单：配对 → 连接 → 绑定 → 双向同步（**含空闲期来信：发完 QQ 消息在 zcode 里随便输一条即可看到注入**）→ 终端镜像（含提示）→ 换会话 `/qq-connect` 接管。

## 8. 依赖

| 包 | 用途 | 许可 |
|---|---|---|
| `@tencent-connect/qqbot-nodejs` ^1.0.5 | 传输：WS 网关 + C2C 收发 | MIT |
| `@tencent-connect/qqbot-connector` ^1.2.0 | 扫码配对 | UNLICENSED（自用可接受，公开发布前需重估，ADR-0003） |
| `qrcode` | 二维码渲染 ASCII | MIT |
| dev: `esbuild`、`@types/node` | 打包、类型 | MIT |

SDK 使用面（真机已验证）：`new QQBot({appId, appSecret, markdownSupport, logger})`、`bot.on("message"|"ready"|"resumed"|"error")`、`bot.start(signal)`、`bot.stop()`、`bot.sendText({scope, targetId, msgId?}, text)`；消息字段 `kind/senderId/content/messageId/replyTarget`。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| **Stop 续跑"至多 3 次"语义不明**（per 事件 or per 回合？JSON 键名？） | **已解决（M0）**：契约 = `{"decision":"block","reason":...}`（reason 即注入内容）；上限 = 每用户回合链 3 次、新回合归零、第 4 次仅忽略不报错。见 ADR-0002「实测」。运行时逐字验证由全局 off 模式探针在新会话自动采集（probe/findings.md §⑥），不阻塞后续里程碑 |
| 模型不遵守 qq_reply 约定 | SKILL.md 强约定 + [QQ] 标记 + Stop 自愈兜底（每回合 1 次） |
| connector UNLICENSED | 自用无约束；若公开发布，降级手动凭据 |
| 每个 Stop spawn node 进程的开销 | 钩子极小（bundle 后 <100KB）、无网关立即退出、timeoutMs 上限 15s |
| 多窗口会话 | 锁互斥 + 钩子只找持锁网关；未持锁会话钩子空转，行为无害退化 |
| QQ 平台怪癖（msg_id 60min 失效、被动 4 条、主动额度） | 全部采用已实测验证的 core.ts 逻辑，不自造 |

## 10. v2+ 路线图

1. **QQ 按钮审批 zcode 权限请求**（杀手级）：PermissionRequest 钩子 → QQ 互动按钮（✅/❌）→ 手机远程批准工具执行。
2. 群聊 @（`allowGroup`，群被动配额 5 条/5 分钟）。
3. typing 提示（SDK `sendTyping`）、工具轨迹（PostToolUse 钩子 → `🔧` 摘要）。
4. Markdown（`markdownSupport`，需平台审核）。
5. 富媒体：收图存插件数据目录后路径交给模型 Read；发文件走 files API。
6. 常驻网关守护进程 + 插件改 http MCP（分层已备好接缝）。
7. 若 zcode 未来开放 assistant 事件：中间消息流式。
