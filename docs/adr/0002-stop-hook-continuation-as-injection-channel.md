# 用 Stop 钩子续跑链实现 QQ→会话注入

zcode 的 7 个钩子事件里只有 **Stop** 能在回合结束后让 agent 带着新上下文继续（返回 JSON 请求续跑，有每次上限，官方文档称至多 3 次，具体语义需实测）。这是把收件箱里的 QQ 消息送进会话的唯一无侵入通道，因此注入、自愈（QQ 驱动的回合没发 qq_reply 时请求续跑提醒补发）都构建在 Stop 钩子上。终端→QQ 镜像用 UserPromptSubmit 钩子；会话→QQ 出站靠 qq_reply MCP 工具 + Stop 自愈兜底。代价：QQ 消息只能回合间排队，无法中途打断（v1 接受）；每次自愈续跑消耗 token，用配置开关控制。

## 实测（2026-10-24，M0 探针 + 源码考古 zcode.cjs v3.16.3）

运行时探针两次未触发（工作区钩子需 UI 审核准入；全局配置的 hookRunner 会话启动时缓存），改由直接阅读 agent runtime 源码确认契约，逐条如下（详见 [../../probe/findings.md](../../probe/findings.md)）：

- **输出 schema**：严格白名单 9 键（`additionalContext`/`additional_context`/`continue`/`decision("approve"|"block")`/`hookSpecificOutput`/`reason`/`stopReason`/`suppressOutput`/`systemMessage`）。
- **续跑判定**：`stopShouldContinue(=continue:true 或 decision:block) && additionalContexts非空 && 本回合计数<3`。**裸 `{"continue":true}` 不续跑**；`{"decision":"block","reason":...}` 的 reason 同时成为注入内容——注入主形态。exit 2 在 Stop 下等效 block。
- **上限语义**：计数器每用户回合归零，链内至多 **3 次注入续跑**；链中 Stop 的 stdin `stop_hook_active=true`；第 4 次 Stop 钩子仍被调用但请求被忽略。→ 回合间隙消化 ≤3 条消息的退化设计成立。
- **注入格式**：合并为一条 `hook_context` 消息（编号拼接），截断 24000 字符（maxChunkChars 4500 无压力）。
- **官方先例**：内置跨会话邮箱即用 `hookSpecificOutput{hookEventName:"Stop",additionalContext} + continue:true` 实现注入+续跑，本机制有平台级背书。
- **stdin**：snake_case 事件字段（`session_id`/`last_assistant_message`/`stop_hook_active`/`transcript_path`…）；`CLAUDE_SESSION_ID`/`ZCODE_PROJECT_DIR` 等同时以 env 注入、argv 模板展开。
- 遗留：运行时逐字验证挂起（探针保留全局配置 off 模式，下个新会话自动采集），不阻塞 M1+。
