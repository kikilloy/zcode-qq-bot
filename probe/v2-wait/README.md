# V0 实验：MCP 工具超时行为（2026-10-25，两轮真机）

wait-probe.mjs 为一次性探针服务器（已从全局配置摘除）；requests.log 为原始证据。
结论已并入 docs/v2-daemon.md §1 证据链。

## 第一轮（会话 session_8fcec37f…）

| 组 | 参数 | 结果 |
|---|---|---|
| A | sleepMs=45000, ping=false | +30.014s 收到 notifications/cancelled；agent 侧 "Tool execution timed out after 30000ms" |
| B | sleepMs=120000, ping=true（15s 心跳） | +30.004s 仍被取消，报错同上 → **progress 心跳救不了** |

- `_meta.progressToken` 随 tools/call 下发（数值型），且 `_meta` 附带 session_id/turn_id/workspace_key 等上下文。
- 报错措辞 "Tool execution timed out after Xms" 定位到 agent 工具执行层（ToolDeadline，绝对定时器），
  非 MCP 适配层（那层模板是 "MCP tool srv/tool timed out after Xms"）。

## 第二轮（会话 session_87226bd9…）

- tools/list 里给 wait_probe 声明 `_meta: {timeoutMs: 1800000}`
- 调用 sleepMs=100000, ping=false → **completed, "waited 100015ms"**，无 cancel

## 结论（写入方案）

1. agent 层默认工具超时 30s 绝对值，progress 重置无效（MCP 层的 resetTimeoutOnProgress 被其覆盖）。
2. **工具定义 `_meta.timeoutMs`（1s ≤ x ≤ 30min）被 agent 层采信** —— qq_wait 的机制基础。
3. 设计：qq_wait 声明 30 分钟超时，等消息或 ~29.5min 到点返回"继续"；空闲成本 ≈ 2 次微型调用/小时。
