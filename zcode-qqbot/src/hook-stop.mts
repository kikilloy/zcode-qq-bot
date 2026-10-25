/**
 * Stop 钩子入口（M4，ADR-0002）：QQ 注入与自愈的唯一通道。
 *
 * 流程：stdin 事件 JSON → 锁文件找控制平面 → /health 探活 → POST /claim
 * （决策矩阵在 gateway.claim：自愈优先 / 收件箱注入 ≤3 条 / none）
 * → 按结果输出续跑 JSON（continuation.ts 契约）或空 JSON。
 * 红线：无锁/网关不可达/任何异常 → 立即空输出 exit 0，绝不报错。
 *
 * stdin 关键字段（M0 实测）：session_id / last_assistant_message / stop_hook_active / transcript_path。
 */

import { blockWithReason } from "./continuation.ts";
import { controlPlaneFetch, controlPlaneUrl, exitQuiet, finishOutput, readStdinJson, sessionIdOf } from "./hook-lib.ts";

const HEALTH_TIMEOUT_MS = 1500;
const CLAIM_TIMEOUT_MS = 4000;

async function main(): Promise<void> {
  const event = await readStdinJson();
  if (!event) return exitQuiet();

  const base = controlPlaneUrl();
  if (!base) return exitQuiet();

  // 探活：锁文件可能是网关进程死后留下的陈旧锁（端口被无关进程复用时不认）。
  const health = (await controlPlaneFetch(base, "/health", { method: "GET" }, HEALTH_TIMEOUT_MS)) as
    | { ok?: boolean }
    | undefined;
  if (!health || health.ok !== true) return exitQuiet();

  const claim = (await controlPlaneFetch(
    base,
    "/claim",
    {
      method: "POST",
      body: JSON.stringify({
        sessionId: sessionIdOf(event),
        stopHookActive: event["stop_hook_active"] === true,
      }),
    },
    CLAIM_TIMEOUT_MS,
  )) as { action?: string; reason?: string } | undefined;

  if (
    claim &&
    (claim.action === "inject" || claim.action === "self-heal") &&
    typeof claim.reason === "string" &&
    claim.reason
  ) {
    finishOutput(blockWithReason(claim.reason));
    return;
  }
  exitQuiet();
}

main().catch(() => exitQuiet());
