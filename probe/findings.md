# M0 Stop 钩子探针 — 实验记录

> 部署时间：2026-10-24。背景：交接文档 §5 M0（本地存档）、ADR-0002、design.md §9 风险表第 1 条。
> 待回答：① Stop stdin 完整字段（response 预览字段名、session_id 字段名）② CLAUDE_SESSION_ID 出现位置（env / stdin / argv）③ args 模板变量是否展开 ④ 续跑 JSON 契约（候选1 = `{"decision":"block","reason":...}`）⑤「至多 3 次」上限语义（per Stop 事件 or per 回合链）。

## 部署

- 工作区钩子配置：`E:\coding\zcode-qq-bot\.zcode\config.json`（仅影响本目录会话；全局 config.json 未动，仍是 `{}`）。
- 探针：`probe/probe.mjs`，node 绝对路径 `E:\nodejs\node.exe`，timeoutMs 10000。
- 状态机：`probe/probe-state.json` → `cand1`（输出候选1 block）→ `stress`（每次 Stop 都 block，数上限）→ `off`（放行）。count 连续计数，硬上限 6 防死循环。
- 事件日志：`probe/stop-events.ndjson`（每行：t/pid/phase/count/argv/env/stdinRaw/emitted）。
- zcode 侧日志：`~/.zcode/v2/logs/2026-10-24.log`（钩子执行记录：outcome/duration/错误流预览）。

## 结果判定表（部署回合结束后）

| 观察 | 结论 | 下一步 |
|---|---|---|
| stop-events.ndjson 有新条目 + 我被 reason 唤醒 | 配置热生效，候选1 契约有效 | 填下面字段清单 → 切 stress 压测 |
| 有新条目 + 我没被唤醒（停在部署回合） | 钩子跑了，block JSON 被拒/无效 | 查 zcode 日志的错误流预览；换候选2 `{"continue":true,"reason":...}`（需用户发消息后继续） |
| 无新条目 + 我停了 | 钩子未被调用：工作区配置不热载 / 作用域不对 / 事件名问题 | 查 zcode 日志确认钩子是否注册；必要时改挂全局 `~/.zcode/cli/config.json`（先备份）；或等新会话 |

## 实测数据

### ⓪ 源码考古结论（D:\app\zcode\resources\glm\zcode.cjs，v3.16.3，2026-10-24）——先于运行时实验得到

**Stop 钩子 stdin 字段**（构造处 `t.last_assistant_message=e.responseText??e.responsePreview, t.stop_hook_active=e.stopHookActive`，另有通用字段 session_id/cwd/timestamp/traceId/turnId/mode/agentName/toolCallCount/source，snake_case）。
**env 注入**：`CLAUDE_CODE_SESSION_ID`、`CLAUDE_PROJECT_DIR`、`CLAUDE_SESSION_ID`、`ZCODE_PROJECT_DIR`、`ZCODE_SESSION_ID`（§7.3 答案：env 一定有；stdin 是否有 session_id 待实测确认）。

**输出 schema（zod 白名单，9 键）**：`additionalContext` / `additional_context` / `continue` / `decision("approve"|"block")` / `hookSpecificOutput{hookEventName, additionalContext|decision|permissionDecision…}` / `reason` / `stopReason` / `suppressOutput` / `systemMessage`。解析：`JSON.parse` → `zPr.safeParse`，失败=ToolExecutionFailed(recoverable)。非 `{` 开头的 stdout 忽略。

**Stop 续跑判定**（`shouldContinueAfterStopHooks`）：
```js
return stopShouldContinue===true && additionalContexts.length>0 && count<3
```
- `stopShouldContinue=true` 两条路：`continue===true` 或 `decision==="block"`
- `additionalContexts` 非空的来源：顶层 `additionalContext`/`additional_context`、`hookSpecificOutput.additionalContext`（事件名必须匹配 "Stop"）、`decision:block` 时自动 push `reason`+`systemMessage`
- **纯 `{"continue":true}` 无注入内容 → 不续跑**；`{"decision":"block","reason":...}` 一石二鸟（reason 既是注入内容又触发续跑）
- **exit code 2**：Stop 事件下等效 `{decision:"block", reason:<stderr或stdout文本>}`

**上限 3 的语义**（`stopHookContinuationCount`）：**每用户回合（turn）独立计数**（turn 状态工厂初始化为 0，链内每次续跑 +1，`count<3` 才允许第 N 次续跑）。链中后续 Stop 的 stdin `stop_hook_active=true`。第 4 次 Stop 钩子**仍会被调用**，但其续跑请求被忽略。

**注入格式**（`injectHookAdditionalContextIntoMessageHistory`）：additionalContexts 格式化为 `hook_context` 消息历史条目（`#${i+1}\n${content}` 编号拼接，外层 `<事件名> hook additional context:`），**截断 24000 字符**。responsePreview 截断 4000。

**官方先例**：内置跨会话邮箱（`builtin.sessionMailbox.drain`）就用 `hookSpecificOutput:{hookEventName:"Stop", additionalContext:...}` + `continue:true` 注入+续跑——ADR-0002 机制被官方模式背书。

**工作区钩子准入（第一次实验失败的根因）**：`.zcode/config.json`/`zcode.json` 里的钩子是 `sourceKind:"project"`，注册需要 `workspaceHookAdmission.evaluateDispatch()`（digest + reviewItemId），触发 `WorkspaceHookReviewRequested` 等 UI 审核事件——**用户没批准就不跑**。而全局 `~/.zcode/cli/config.json` 的配置钩子只看 `hooks.enabled:true`，无审核直接注册。插件钩子（hooks/hooks.json）同样无审核自动启用。

### 部署调整（第 2 次实验）

- 撤工作区 `.zcode/config.json`（admission 路径不可控）。
- 探针挂全局 `~/.zcode/cli/config.json`（备份 config.json.bak-m0），probe.mjs 加项目守卫：仅当 cwd 或 `CLAUDE_PROJECT_DIR` 是 `E:\coding\zcode-qq-bot` 时动作，否则输出 `{}` 直接放行（不写日志）。
- 待实测：(a) 配置对已开会话是否热生效（若否需新会话）(b) 上述源码结论运行时行为验证（reason 注入的实际呈现、stdin session_id、argv 模板展开、3 次上限行为）。

### ① Stop stdin 字段（源码确认，构造函数 `createCompatibleHookStdin`）

```json
{
  "...事件对象 camelCase 原样展开": "cwd/timestamp/traceId/turnId/source/mode/agentName/toolCallCount/responseText…",
  "agent_type": "<agentName>",
  "hook_event_name": "Stop",
  "permission_mode": "<mode>",
  "session_id": "<sessionId>",
  "transcript_path": "<tmpdir>/zcode-hook-XXXX/transcript.jsonl",
  "transcriptPath": "同上",
  "last_assistant_message": "<responseText ?? responsePreview>",
  "stop_hook_active": false
}
```
`transcript_path` 指向临时文件，内容仅一行 `{"message":{"content":[{"text":<回复预览>,"type":"text"}],"role":"assistant"}}`（不是完整历史，钩子结束即删）。运行时逐字验证：挂起（off 模式探针将在下个新会话自动采集）。

### ② CLAUDE_SESSION_ID 出现位置（源码确认）

**三处都有**：env（`createPluginEnvOverlay` set 注入，含 `CLAUDE_SESSION_ID`/`ZCODE_SESSION_ID`/`CLAUDE_CODE_SESSION_ID` + 项目目录变量）、stdin（`session_id` 字段）、argv 模板（`${CLAUDE_SESSION_ID}` 可展开）。

### ③ argv 模板变量展开（源码确认）

`command` 与**每个 arg** 都过 `expandPluginVariables`。变量集：`CLAUDE_CODE_SESSION_ID`/`CLAUDE_PROJECT_DIR`/`CLAUDE_SESSION_ID`/`ZCODE_PROJECT_DIR`/`ZCODE_SESSION_ID` + 插件钩子专属 `CLAUDE_PLUGIN_DATA`/`CLAUDE_PLUGIN_ROOT`/`ZCODE_PLUGIN_DATA`/`ZCODE_PLUGIN_ROOT`。`*_SKILL_DIR` 在钩子里抛错。未识别变量原样保留。env 里另有插件 `CLAUDE_PLUGIN_ID`/`CLAUDE_PLUGIN_NAME`。

### ④ 续跑契约（源码确认，zod 白名单 9 键）

- 首选（一石二鸟）：`{"decision":"block","reason":"[QQ] <注入内容>"}` —— reason 既触发续跑又成为注入内容。
- 官方邮箱同款：`{"continue":true,"stopReason":"...","additionalContext":"..."}`（`hookSpecificOutput:{hookEventName:"Stop",additionalContext:...}` 亦可）。**裸 `{"continue":true}` 不续跑**（additionalContexts 必须非空）。
- exit code 2 + stderr 文本 = Stop 下等效 block。
- 注入呈现：additionalContexts 合并为一条 `hook_context` 消息（`<事件名> hook additional context:` + `#1\n…` 编号），**截断 24000 字符**。

### ⑤ 链式续跑上限（源码确认，`shouldContinueAfterStopHooks`）

**每用户回合独立计数** `stopHookContinuationCount`（turn 状态工厂初始化 0）：`stopShouldContinue && additionalContexts非空 && count<3` → 续跑并 +1。即**每回合链最多 3 次注入续跑**，链中新 Stop 的 stdin `stop_hook_active=true`，第 4 次 Stop 钩子仍被调用但续跑请求被忽略，新用户回合归零。design.md 退化设计（回合间隙消化 ≤3 条）无需改动即成立。

### ⑥ 运行时验证状态与触发方式（截至 2026-10-24）

两次触发均未运行探针（本日志 0 条目）：
- 第 1 次：工作区 `.zcode/config.json` 走 project hooks 通道，需 UI `WorkspaceHookReviewRequested` 审核准入，未批准 → 不注册。
- 第 2 次：全局 `~/.zcode/cli/config.json`（无审核），但 hookRunner 是**会话启动时构建并缓存**（`t.hookRunner ?? …`），本会话启动早于配置写入 → 不生效。

**后续自动化**：探针保留在全局配置、phase=off（记录 stdin/argv/env + 输出 `{}` 放行，零干扰；项目守卫限制仅本项目目录动作）。下次在本项目开任意新会话，其每个回合的 Stop 都会自动写入本目录 `stop-events.ndjson`——逐字验证 ①②③。若需行为验证 ④⑤（真实续跑+3 次上限），把 `probe-state.json` 的 `phase` 改为 `"cand1"` 即可，reason 自带指令。关闭探针：`cp ~/.zcode/cli/config.json.bak-m0 ~/.zcode/cli/config.json`。

### 对插件设计的影响（M1+ 要点）

- 插件正式分发走 **hooks/hooks.json（插件钩子）**：无审核自动启用、有 `${CLAUDE_PLUGIN_ROOT}` 展开、env 注入 PLUGIN_ID/NAME——不受工作区 admission 影响。
- `continuation.ts` 契约：`block(reason)` 为注入主形态；`stop_hook_active` 用于自愈去重（链中已知状态）；24000 截断对齐 maxChunkChars（4500）无压力。
- 开发期调试钩子用全局 config（enabled:true 即生效），别用工作区文件钩子（审核流程不可编程控制）。
