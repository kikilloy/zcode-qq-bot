#!/usr/bin/env node
// M0 Stop 钩子探针 —— 任务背景见交接文档 §5 M0（本地存档）。
// 目的：实测 zcode Stop 钩子 (1) stdin 事件字段 (2) CLAUDE_SESSION_ID 出现位置（env/stdin/argv）
//      (3) 续跑 JSON 契约（先试 Claude Code 惯例 {"decision":"block","reason":...}）
//      (4) “至多 3 次”续跑上限的语义（链式压测）。
// 行为由 probe-state.json 控制：phase = cand1 | stress | off；count 连续计数，硬上限 hardMax 防死循环。
// 约束：stdout 只能是严格 JSON（多余键判失败）；必须毫秒级完成；永不崩溃（非零退出码=钩子错误）。
import fs from "node:fs";

const DIR = "E:/coding/zcode-qq-bot/probe";
const LOG = `${DIR}/stop-events.ndjson`;
const STATE = `${DIR}/probe-state.json`;

function tryReadJson(p, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(p, "utf8")) }; }
  catch { return fallback; }
}

// stdin 原文（可能没有 stdin 或为空——都不能崩）
let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
  if (raw.length > 65536) raw = raw.slice(0, 65536) + "…[truncated]";
} catch { raw = ""; }

// 模板变量展开验证（argv）+ env 出现位置验证
const argv = process.argv.slice(2);
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(CLAUDE|ZCODE|ANTHROPIC)/.test(k)) env[k] = v;
}

const DEFAULT_STATE = { phase: "cand1", count: 0, hardMax: 6 };
const st = tryReadJson(STATE, DEFAULT_STATE);
st.count = Number(st.count) || 0;

// 项目守卫：探针挂在全局 config（会影响所有会话），只在本项目目录的会话里动作，
// 其他会话零成本放行（{} + exit 0，不写日志不动作）。
const PROJECT = "e:/coding/zcode-qq-bot";
const norm = (p) => String(p ?? "").toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
const inProject =
  norm(process.env.CLAUDE_PROJECT_DIR) === PROJECT ||
  norm(process.env.ZCODE_PROJECT_DIR) === PROJECT ||
  norm(process.cwd()) === PROJECT;
if (!inProject) {
  process.stdout.write("{}");
  process.exit(0);
}

let out = {}; // 空对象 = 正常放行
if (st.phase === "cand1" && st.count < st.hardMax) {
  st.count += 1;
  out = {
    decision: "block",
    reason:
      `[M0 Stop 探针] 候选1 {"decision":"block"} 续跑成功，第 ${st.count} 次唤醒。` +
      (st.count === 1
        ? `请立即做四件事后结束回合：(1) 读 E:/coding/zcode-qq-bot/probe/findings.md（已含源码考古结论）与交接文档 §5 M0（本地存档）；(2) 把 stop-events.ndjson 最后一条的 stdin 字段清单补进 findings.md 的"①"节（含 session_id 有无、argv 模板变量是否展开）；(3) 把 probe-state.json 的 phase 改为 "stress"（count 保留）；(4) 结束回合，开始链式压测。若你在新会话中醒来且无上文记忆，照此执行即可。`
        : `只回复一行 "AWAKE cand1 #${st.count}"，不要使用任何工具，然后立即结束回合。`),
  };
} else if (st.phase === "stress" && st.count < st.hardMax) {
  st.count += 1;
  out = {
    decision: "block",
    reason:
      `[M0 压测] 第 ${st.count}/${st.hardMax} 次 Stop 续跑（预期上限 3 次/回合，源码已证，此为行为验证）。不要使用任何工具，只回复一行 "STRESS #${st.count}" 然后立即结束回合。`,
  };
}
// phase=off 或 count>=hardMax → out 保持 {} 放行

const rec = { t: new Date().toISOString(), pid: process.pid, phase: st.phase, count: st.count, argv, env, stdinRaw: raw, emitted: out };
try { fs.appendFileSync(LOG, JSON.stringify(rec) + "\n"); } catch { /* 日志失败不影响钩子输出 */ }
try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch { /* 状态写失败：下次用默认 cand1/0，安全 */ }

process.stdout.write(JSON.stringify(out));
process.exit(0);
