/**
 * Stop 续跑输出契约（M0 源码考古定案，ADR-0002「实测」；隔离在此——schema 变化只改这个文件）。
 *
 * zcode 钩子 stdout 必须是严格 JSON，zod 白名单 9 键（多余键判失败）：
 *   additionalContext / additional_context / continue / decision("approve"|"block") /
 *   reason / stopReason / suppressOutput / systemMessage / hookSpecificOutput
 *
 * 续跑判定（shouldContinueAfterStopHooks）：
 *   (continue===true 或 decision==="block") && 注入内容非空 && 本回合链计数 < 3。
 * 主形态 {"decision":"block","reason":...} 一石二鸟——reason 既触发续跑又成为注入内容。
 * 裸 {"continue":true} 不续跑（注入内容为空）。注入合并为一条 hook_context 消息，
 * 截断 24000 字符。上限语义：每用户回合链 3 次，新回合归零，第 4 次 Stop 仍调用钩子但忽略请求。
 */

/** 每用户回合链的注入续跑上限（与 gateway.CLAIM_MAX_PER_TURN 对齐，QQ 来信每回合消化 ≤3 条）。 */
export const MAX_CONTINUATIONS_PER_TURN = 3;
/** 注入内容截断上限（zcode hook_context 消息级截断）。 */
export const MAX_INJECTION_CHARS = 24000;

/** 正常收尾：空 JSON（无任何键值语义，Stop 正常结束）。 */
export const EMPTY_OUTPUT = "{}";

/** 注入/自愈续跑主形态：decision:block + reason（reason 即注入内容）。 */
export function blockWithReason(reason: string): string {
  return JSON.stringify({ decision: "block", reason: clampInjection(reason) });
}

/** 备选形态（官方跨会话邮箱同款）：continue + additionalContext。 */
export function continueWithContext(additionalContext: string, stopReason?: string): string {
  const payload: Record<string, unknown> = { continue: true, additionalContext: clampInjection(additionalContext) };
  if (stopReason) payload.stopReason = stopReason;
  return JSON.stringify(payload);
}

export function clampInjection(text: string): string {
  return text.length > MAX_INJECTION_CHARS ? `${text.slice(0, MAX_INJECTION_CHARS)}…（已截断）` : text;
}
