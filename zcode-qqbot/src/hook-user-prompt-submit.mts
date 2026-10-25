/**
 * UserPromptSubmit 钩子入口（M4 建，0.3.0 扩展）。两件事，顺序不可换：
 *
 *   1. 终端镜像上报（默认关）——POST /terminal-mirror {text, sessionId}。
 *      网关守卫决定是否真发 QQ（持锁会话/已连接/开关开/非斜杠），并标记终端回合、
 *      清除自愈刺激（真实终端输入意味着本回合不是 QQ 驱动）。
 *   2. 取信注入（0.3.0 主修）——POST /claim {sessionId, via:"ups"}。真机复盘发现：
 *      会话空闲时没有 Stop 事件，空闲期到达的 QQ 来信会滞留收件箱直到下一个回合
 *      结束才注入。现在提交任何提示词（含斜杠命令轮）都先取一次信，以
 *      additionalContext 随本次提示词进会话。
 *
 * 顺序约束：必须先 mirror 后 claim。mirror 无条件清刺激，claim 注入要重新立起
 * 刺激；反过来的话刚立的刺激会被 mirror 清掉，模型忘回复时 Stop 就不再自愈。
 *
 * 输出：取到信时写 {"additionalContext": "..."}（zcode.cjs 实证：顶层键对所有事件
 * 无条件注入，且与 hookSpecificOutput 双写会重复注入——只用顶层键）；取不到信
 * 不写 stdout（空输出被忽略）。任何异常静默退出——镜像/取信失败绝不干扰回合。
 */

import { controlPlaneFetch, controlPlaneUrl, exitSilent, finishOutput, readStdinJson, sessionIdOf } from "./hook-lib.ts";
import { clampInjection } from "./continuation.ts";

const MIRROR_TIMEOUT_MS = 8000;
const CLAIM_TIMEOUT_MS = 4000;

function promptTextOf(event: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["prompt", "userPrompt", "user_prompt"]) {
    const v = event?.[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

async function main(): Promise<void> {
  const event = await readStdinJson();
  if (!event) return exitSilent();

  const base = controlPlaneUrl();
  if (!base) return exitSilent();

  const sessionId = sessionIdOf(event);
  const text = promptTextOf(event);

  // 1) 镜像：响应内容无关紧要（超时/失败由网关侧兜底，QQ 发送在网关进程内继续）。
  if (text) {
    await controlPlaneFetch(
      base,
      "/terminal-mirror",
      { method: "POST", body: JSON.stringify({ sessionId, text }) },
      MIRROR_TIMEOUT_MS,
    );
  }

  // 2) 取信：决策矩阵与 Stop 同一套（自愈优先于新消息注入）。
  const claim = (await controlPlaneFetch(
    base,
    "/claim",
    { method: "POST", body: JSON.stringify({ sessionId, via: "ups" }) },
    CLAIM_TIMEOUT_MS,
  )) as { action?: string; reason?: unknown } | undefined;

  if (
    claim &&
    (claim.action === "inject" || claim.action === "self-heal") &&
    typeof claim.reason === "string" &&
    claim.reason
  ) {
    return finishOutput(JSON.stringify({ additionalContext: clampInjection(claim.reason) }));
  }
  exitSilent();
}

main().catch(() => exitSilent());
