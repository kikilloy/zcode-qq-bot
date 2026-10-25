/**
 * 钩子端到端 harness（M4）：真实钩子脚本子进程 × 真网关 × 真控制平面。
 * 覆盖 design.md §4/§7：Stop 决策矩阵四象限（注入/自愈/两者/无）经钩子 stdin→HTTP→stdout
 * 全链路；无锁/陈旧锁快速空退出；UserPromptSubmit 终端镜像与守卫。
 * 主线跑 src/*.mts（Node 类型剥离，npm test 无需先 build）；dist 存在时追加 bundle 抽查。
 * Run: node test/hook-harness.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const home = mkdtempSync(join(tmpdir(), "qqbot-hook-"));
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    appId: "123456",
    appSecret: "s3cret",
    markdownSupport: false,
    allowFrom: ["owner-1"],
    maxChunkChars: 500,
    forwardTerminal: true,
    allowGroup: false,
    autoConnect: true,
    selfHeal: true,
    idleNotify: false,
    idleAck: false,
  }),
);
process.env.ZCODE_QQBOT_CONFIG = join(home, "config.json");
process.env.ZCODE_QQBOT_STATE = join(home, "state.json");
process.env.ZCODE_QQBOT_LOCK = join(home, "lock.json");
process.env.ZCODE_QQBOT_LOG = join(home, "log.jsonl");
process.env.ZCODE_QQBOT_SDK = pathToFileURL(join(here, "fake-sdk.mjs")).href;
globalThis.__qqBotFake = { instances: [] };

const HOOKS = {
  stop: join(root, "src", "hook-stop.mts"),
  ups: join(root, "src", "hook-user-prompt-submit.mts"),
};
const DIST_STOP = join(root, "dist", "hook-stop.mjs");

/** 跑一个钩子脚本，喂 stdin，收 {code, out, err, ms}。 */
function runHook(script, stdinJson, envOver = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...envOver },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hook timeout: ${script}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, ms: Date.now() - t0 });
    });
    child.stdin.end(stdinJson);
  });
}

const stopStdin = (over = {}) =>
  JSON.stringify({ session_id: "sess-H", stop_hook_active: false, last_assistant_message: "回复预览", ...over });
const upsStdin = (prompt, over = {}) => JSON.stringify({ session_id: "sess-H", prompt, ...over });
const parseOut = (r) => JSON.parse(r.out);

// -- 1. 无锁：立即空输出退出（红线：钩子必须便宜） --------------------------
let r = await runHook(HOOKS.stop, stopStdin(), { ZCODE_QQBOT_LOCK: join(home, "不存在.json") });
assert.equal(r.code, 0);
assert.deepEqual(parseOut(r), {});
assert.equal(r.err, "", "无锁时不得写 stderr");
assert.ok(r.ms < 2000, `无锁应秒退，实际 ${r.ms}ms`);
console.log("ok  无锁：空 JSON 快速退出（%dms）", r.ms);

// 非法 stdin 同样静默空输出
r = await runHook(HOOKS.stop, "不是 json{{{");
assert.equal(r.code, 0);
assert.deepEqual(parseOut(r), {});
console.log("ok  非法 stdin：空 JSON 不报错");

// -- 2. 陈旧锁指向死端口：/health 不通 → 空输出 -----------------------------
writeFileSync(
  join(home, "lock.json"),
  JSON.stringify({ pid: 31337, host: "ghost", port: 1, at: Date.now() }) + "\n",
);
r = await runHook(HOOKS.stop, stopStdin());
assert.equal(r.code, 0);
assert.deepEqual(parseOut(r), {});
assert.equal(r.err, "");
assert.ok(r.ms < 3000, `死端口应快速失败，实际 ${r.ms}ms`);
rmSync(join(home, "lock.json"), { force: true });
console.log("ok  陈旧锁/死端口：空 JSON 快速退出（%dms）", r.ms);

// -- 3. 真网关 + 真控制平面 ------------------------------------------------
const { Gateway } = await import("../src/gateway.ts");
const { startControlPlane } = await import("../src/control-plane.ts");

const gw = new Gateway({ sessionId: "sess-H", pid: 100 });
const cp = await startControlPlane(gw);
gw.setPort(cp.port);
await gw.init();
const bot = globalThis.__qqBotFake.instances.at(-1);
assert.ok(bot?.started, "autoConnect 应启动 fake 传输");
bot.emitReady();
const lockRaw = JSON.parse(readFileSync(join(home, "lock.json"), "utf8"));
assert.equal(lockRaw.port, cp.port, "锁文件应带控制平面端口");
console.log("ok  网关上线，锁落盘 port=%d", cp.port);

const inbound = (over = {}) => ({
  kind: "c2c",
  senderId: "owner-1",
  content: "你好",
  messageId: "m1",
  replyTarget: { scope: "c2c", targetId: "owner-1", msgId: "m1" },
  ...over,
});

// -- 4. Q1 注入：收件箱 → decision:block + [QQ] reason ----------------------
await bot.emitMessage({}, inbound());
r = await runHook(HOOKS.stop, stopStdin());
assert.equal(r.code, 0);
let j = parseOut(r);
assert.deepEqual(Object.keys(j).sort(), ["decision", "reason"], "输出必须严格白名单键");
assert.equal(j.decision, "block");
assert.match(j.reason, /\[QQ\] 你好（来自 owner-1，/);
assert.equal(gw.status().inboxCount, 0, "claim 后收件箱清空");
console.log("ok  Q1 注入：hook stdout = block + [QQ] reason");

// -- 5. Q2 自愈：注入未回复 → 自愈提醒一次，再跑 → 空 ------------------------
r = await runHook(HOOKS.stop, stopStdin({ stop_hook_active: true }));
j = parseOut(r);
assert.equal(j.decision, "block");
assert.match(j.reason, /qq_reply/);
r = await runHook(HOOKS.stop, stopStdin({ stop_hook_active: true }));
assert.deepEqual(parseOut(r), {}, "同一刺激至多自愈一次");
console.log("ok  Q2 自愈：一次提醒后放行");

// -- 6. Q3 两者：未回复注入 + 收件箱新消息 → 自愈优先，随后才注入 ------------
await bot.emitMessage({}, inbound({ content: "第二条", messageId: "m2" }));
r = await runHook(HOOKS.stop, stopStdin());
assert.match(parseOut(r).reason, /第二条/); // 上轮自愈后刺激已翻转 → 注入 m2
await bot.emitMessage({}, inbound({ content: "第三条", messageId: "m3" }));
r = await runHook(HOOKS.stop, stopStdin());
assert.match(parseOut(r).reason, /qq_reply/, "矩阵顺序：自愈优先于新消息注入");
r = await runHook(HOOKS.stop, stopStdin());
assert.match(parseOut(r).reason, /第三条/);
console.log("ok  Q3 两者：自愈优先 → 随后注入新消息");

// -- 7. 会话不匹配：claim 无副作用，收件箱保留 ------------------------------
await bot.emitMessage({}, inbound({ content: "别的会话看不到", messageId: "m4" }));
r = await runHook(HOOKS.stop, stopStdin({ session_id: "sess-OTHER" }));
assert.deepEqual(parseOut(r), {});
assert.equal(gw.status().inboxCount, 1, "不匹配会话不得取走收件箱");
r = await runHook(HOOKS.stop, stopStdin());
assert.match(parseOut(r).reason, /qq_reply/, "m3 注入未回复：自愈优先于新消息注入");
r = await runHook(HOOKS.stop, stopStdin());
assert.match(parseOut(r).reason, /别的会话看不到/);
console.log("ok  会话不匹配：空输出且收件箱不动");

// -- 8. Q4 无：履行回复义务 → 空 JSON --------------------------------------
let rep = await gw.reply("收到");
assert.equal(rep.ok, true);
r = await runHook(HOOKS.stop, stopStdin());
assert.deepEqual(parseOut(r), {});
console.log("ok  Q4 无刺激：空 JSON 正常收尾");

// -- 9. UserPromptSubmit：终端镜像 + 守卫 ------------------------------------
await bot.emitMessage(
  {},
  inbound({ content: "m5", messageId: "m5", replyTarget: { scope: "c2c", targetId: "owner-1", msgId: "m5" } }),
);
await runHook(HOOKS.stop, stopStdin()); // 消化 m5（注入），留下 fresh msgId 目标
const sentBefore = bot.sent.length;
r = await runHook(HOOKS.ups, upsStdin("终端输入"));
assert.equal(r.code, 0);
assert.equal(r.out.trim(), "", "UserPromptSubmit 不得写 stdout");
assert.equal(bot.sent.length, sentBefore + 1, "镜像应发送一条");
assert.equal(bot.sent.at(-1).content, "🖥 终端\n终端输入");
assert.equal(bot.sent.at(-1).target.msgId, "m5", "镜像走被动回复");
console.log("ok  终端镜像：🖥 前缀 + 被动回复 + stdout 干净");

r = await runHook(HOOKS.ups, upsStdin("/秘密斜杠"));
assert.equal(bot.sent.length, sentBefore + 1, "斜杠命令不镜像");
await gw.applyConfig({ forwardTerminal: false });
r = await runHook(HOOKS.ups, upsStdin("镜像已关"));
assert.equal(bot.sent.length, sentBefore + 1, "开关关闭不镜像");
await gw.applyConfig({ forwardTerminal: true });
console.log("ok  镜像守卫：斜杠/开关关闭");

r = await runHook(HOOKS.ups, upsStdin("无锁也安静"), { ZCODE_QQBOT_LOCK: join(home, "不存在.json") });
assert.equal(r.code, 0);
assert.equal(r.out.trim(), "");
console.log("ok  UserPromptSubmit 无锁：静默退出");

// -- 9b. UserPromptSubmit 取信：空闲期来信随提示词注入（0.3.0 主修场景回放） ----
// 真机复盘（2026-10-25）：绑定回合 06:16:10 结束后 "hi" 06:16:41 入箱，会话空闲
// 没有 Stop 事件 → 消息滞收到手动断开。现在 UPS 钩子补上：提交提示词即取信。
await bot.emitMessage(
  {},
  inbound({ content: "空闲期来信", messageId: "m8", replyTarget: { scope: "c2c", targetId: "owner-1", msgId: "m8" } }),
);
r = await runHook(HOOKS.ups, upsStdin("随便输点什么"));
j = parseOut(r);
assert.deepEqual(Object.keys(j).sort(), ["additionalContext"], "UPS 取信输出必须只有 additionalContext");
assert.match(j.additionalContext, /\[QQ\] 空闲期来信（来自 owner-1，/);
assert.equal(gw.status().inboxCount, 0, "UPS 取信后收件箱清空");
console.log("ok  UPS 取信：additionalContext 注入，收件箱清空");

// 顺序语义：mirror 先清刺激、claim 后立刺激 → 模型忘回复时 Stop 仍会自愈
r = await runHook(HOOKS.stop, stopStdin());
assert.equal(parseOut(r).decision, "block");
assert.match(parseOut(r).reason, /qq_reply/, "UPS 注入未回复：Stop 自愈仍生效（先镜像后取信）");
await gw.reply("补回复");
r = await runHook(HOOKS.ups, upsStdin("再输一条"));
assert.equal(r.out.trim(), "", "无信可取时 UPS 不写 stdout");
console.log("ok  UPS 取信顺序：自愈语义保持，无信时 stdout 干净");

// -- 10. dist bundle 抽查（若已 build）--------------------------------------
if (existsSync(DIST_STOP)) {
  await bot.emitMessage(
    {},
    inbound({ content: "bundle 来信", messageId: "m6", replyTarget: { scope: "c2c", targetId: "owner-1", msgId: "m6" } }),
  );
  r = await runHook(DIST_STOP, stopStdin());
  assert.equal(parseOut(r).decision, "block");
  assert.match(parseOut(r).reason, /bundle 来信/);
  await gw.reply("bundle 回复");
  r = await runHook(DIST_STOP, stopStdin());
  assert.deepEqual(parseOut(r), {});
  console.log("ok  dist/hook-stop.mjs bundle：注入/收尾两态正确");
} else {
  console.log("跳过 dist 抽查（未 build）");
}

// -- 清理 -------------------------------------------------------------------
await cp.close();
gw.disconnect();
console.log("\nHOOK HARNESS PASSED");
