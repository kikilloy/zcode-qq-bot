/**
 * Bundle 级跨进程端到端（M6 验收件）：真实 dist/mcp-server.mjs 子进程（autoConnect
 * 网关 + 控制平面）× 真实 dist/hook-*.mjs 子进程，唯一通道是锁文件 + 127.0.0.1 HTTP
 * ——对真实 zcode 会话行为的最后模拟（进程边界与部署形态完全一致）。
 * 前置：npm run build。Run: node test/bundle-e2e.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DIST_SERVER = join(root, "dist", "mcp-server.mjs");
const DIST_STOP = join(root, "dist", "hook-stop.mjs");
const DIST_UPS = join(root, "dist", "hook-user-prompt-submit.mjs");
for (const f of [DIST_SERVER, DIST_STOP, DIST_UPS]) {
  assert.ok(existsSync(f), `缺少 ${f}——先 npm run build`);
}

const home = mkdtempSync(join(tmpdir(), "qqbot-e2e-"));
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
  }),
);
const lockFile = join(home, "lock.json");
const fakePort = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

const childEnv = {
  ...process.env,
  ZCODE_QQBOT_CONFIG: join(home, "config.json"),
  ZCODE_QQBOT_STATE: join(home, "state.json"),
  ZCODE_QQBOT_LOCK: lockFile,
  ZCODE_QQBOT_LOG: join(home, "log.jsonl"),
  ZCODE_QQBOT_SDK: pathToFileURL(join(here, "fake-sdk-remote.mjs")).href,
  ZCODE_QQBOT_FAKE_PORT: String(fakePort),
  ZCODE_QQBOT_SESSION_ID: "sess-E2E",
};
const fake = (path, init) => fetch(`http://127.0.0.1:${fakePort}${path}`, init).then((r) => r.json());

// -- 1. 启动 mcp-server（网关进程），MCP 握手 --------------------------------
const server = spawn(process.execPath, [DIST_SERVER], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
let serverErr = "";
server.stderr.on("data", (d) => (serverErr += d));
const rl = createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {
    // 非协议行忽略
  }
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 10000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "e2e", version: "0.0.0" },
});
const tools = await rpc("tools/list", {});
assert.equal(tools.tools.length, 14, `应注册 14 个工具，实际 ${tools.tools.length}`);
// v2 值守：qq_wait 必须携带 _meta.timeoutMs=1800000（agent 层长超时的唯一开关，V0 实测）
const waitTool = tools.tools.find((t) => t.name === "qq_wait");
assert.ok(waitTool, "qq_wait 应在工具列表中");
assert.deepEqual(waitTool._meta, { timeoutMs: 1800000 }, "qq_wait 应声明 30 分钟工具超时");
assert.equal(tools.tools.filter((t) => t._meta).length, 1, "只有 qq_wait 携带 _meta，其余走默认超时");
console.log("ok  mcp-server 握手，14 个工具在线（qq_wait 带 _meta.timeoutMs=1800000）");

// -- 2. autoConnect 网关抢锁（钩子靠锁文件寻址的唯一依据）--------------------
const lock = await (async () => {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(readFileSync(lockFile, "utf8"));
      if (raw.port) return raw;
    } catch {
      // 还没写
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`autoConnect 未在 6s 内写锁：stderr=${serverErr}`);
})();
await fake("/ready", { method: "POST" });
const health = await (await fetch(`http://127.0.0.1:${lock.port}/health`)).json();
assert.equal(health.ok, true);
assert.equal(health.sessionId, "sess-E2E", "锁里的会话应与 env 注入一致");
console.log("ok  autoConnect 抢锁 port=%d，/health 可达，sessionId 注入生效", lock.port);

// -- 3. 钩子进程 × 网关进程的注入闭环 ---------------------------------------
const runHook = (script, stdinJson) =>
  new Promise((resolve, reject) => {
    const h = spawn(process.execPath, [script], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    h.stdout.on("data", (d) => (out += d));
    h.on("error", reject);
    h.on("close", (code) => resolve({ code, out }));
    h.stdin.end(stdinJson);
  });
const stopStdin = () => JSON.stringify({ session_id: "sess-E2E", stop_hook_active: false });

await fake("/emit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msg: { kind: "c2c", senderId: "owner-1", content: "手机来信", messageId: "m1" } }) });
let r = await runHook(DIST_STOP, stopStdin());
let j = JSON.parse(r.out);
assert.equal(j.decision, "block");
assert.match(j.reason, /\[QQ\] 手机来信（来自 owner-1，/);
console.log("ok  跨进程注入闭环：QQ 来信 → 收件箱 → Stop 钩子 block 注入");

// -- 4. qq_reply 出站 + 自愈解除 --------------------------------------------
const call = await rpc("tools/call", { name: "qq_reply", arguments: { text: "已收到" } });
assert.ok(!call.isError, `qq_reply 不应报错：${JSON.stringify(call)}`);
let sent = await fake("/sent");
assert.equal(sent.at(-1).content, "已收到");
assert.equal(sent.at(-1).target.msgId, "m1", "应走被动回复");
r = await runHook(DIST_STOP, stopStdin());
assert.deepEqual(JSON.parse(r.out), {}, "已回复后 Stop 应放行");
console.log("ok  qq_reply 被动出站，Stop 放行");

// -- 5. UserPromptSubmit 终端镜像（跨进程）-----------------------------------
r = await runHook(DIST_UPS, JSON.stringify({ session_id: "sess-E2E", prompt: "终端输入" }));
assert.equal(r.out.trim(), "");
sent = await fake("/sent");
assert.equal(sent.at(-1).content, "🖥 终端\n终端输入");
console.log("ok  终端镜像：UserPromptSubmit 钩子 → 🖥 前缀转发");

// -- 5b. UserPromptSubmit 取信：空闲期来信随提示词注入（0.3.0 主修） -----------
await fake("/emit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ msg: { kind: "c2c", senderId: "owner-1", content: "空闲期来信", messageId: "m2" } }),
});
r = await runHook(DIST_UPS, JSON.stringify({ session_id: "sess-E2E", prompt: "继续" }));
j = JSON.parse(r.out);
assert.deepEqual(Object.keys(j).sort(), ["additionalContext"], "UPS 取信只输出 additionalContext");
assert.match(j.additionalContext, /\[QQ\] 空闲期来信（来自 owner-1，/);
await rpc("tools/call", { name: "qq_reply", arguments: { text: "收到空闲消息" } });
r = await runHook(DIST_STOP, stopStdin());
assert.deepEqual(JSON.parse(r.out), {}, "补回复后 Stop 放行");
console.log("ok  UPS 取信闭环：空闲来信 → additionalContext 注入 → 回复后放行");

// -- 5c. 值守循环（0.4.0）：qq_wait 经真实 bundle 阻塞等待并唤醒 -------------
const waitCall = rpc("tools/call", { name: "qq_wait", arguments: { maxWaitSec: 8 } });
await new Promise((res) => setTimeout(res, 500));
await fake("/emit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ msg: { kind: "c2c", senderId: "owner-1", content: "值守来电话", messageId: "m3" } }),
});
const waitRes = await waitCall;
assert.ok(!waitRes.isError, `qq_wait 不应报错：${JSON.stringify(waitRes)}`);
assert.match(waitRes.content[0].text, /\[QQ\] 值守来电话/, "qq_wait 应返回等待期到达的来信");
// 矩阵顺序：先回复履行义务（否则自愈抢先），之后无等待者的值守才由 Stop 兜底拉回
await rpc("tools/call", { name: "qq_reply", arguments: { text: "值守已收到" } });
r = await runHook(DIST_STOP, stopStdin());
j = JSON.parse(r.out);
assert.equal(j.decision, "block");
assert.match(j.reason, /值守循环中断/, "值守断线时 Stop 应注入值守续跑提醒");
await rpc("tools/call", { name: "qq_watch_stop", arguments: {} });
r = await runHook(DIST_STOP, stopStdin());
assert.deepEqual(JSON.parse(r.out), {}, "qq_watch_stop 后 Stop 放行");
console.log("ok  值守循环：qq_wait 阻塞唤醒 + Stop 兜底 + qq_watch_stop 退出");

// -- 6. 双进程接管（0.3.1）：第二个 mcp-server 经 /shutdown 请第一个让位 ------
const fake2Port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const server2 = spawn(process.execPath, [DIST_SERVER], {
  env: { ...childEnv, ZCODE_QQBOT_FAKE_PORT: String(fake2Port) },
  stdio: ["pipe", "pipe", "pipe"],
});
let server2Err = "";
server2.stderr.on("data", (d) => (server2Err += d));
const rl2 = createInterface({ input: server2.stdout });
const pending2 = new Map();
rl2.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending2.has(msg.id)) {
      pending2.get(msg.id)(msg);
      pending2.delete(msg.id);
    }
  } catch {
    // 非协议行忽略
  }
});
const rpc2 = (method, params) =>
  new Promise((resolve, reject) => {
    const id = 10000 + nextId++;
    const timer = setTimeout(() => reject(new Error(`rpc2 timeout: ${method}`)), 10000);
    pending2.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    server2.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
await rpc2("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "e2e", version: "0.0.0" },
});
await new Promise((r) => setTimeout(r, 1500)); // 让 server2 的 autoConnect 先撞一次活锁
const lockStill1 = JSON.parse(readFileSync(lockFile, "utf8"));
assert.equal(lockStill1.pid, server.pid, "autoConnect 不得抢活锁");

const conn2P = rpc2("tools/call", { name: "qq_connect", arguments: {} });
await new Promise((r) => setTimeout(r, 1200)); // 让位 + 抢锁 + 起传输
await fetch(`http://127.0.0.1:${fake2Port}/ready`, { method: "POST" });
const conn2 = await conn2P;
assert.match(JSON.stringify(conn2), /已连接.*接管/, `qq_connect 应报告接管：${JSON.stringify(conn2)}`);
const lockB = JSON.parse(readFileSync(lockFile, "utf8"));
assert.equal(lockB.pid, server2.pid, "锁应换主到 server2");
const st1 = await rpc("tools/call", { name: "qq_status", arguments: {} });
assert.match(JSON.stringify(st1), /running\\?":\s*false/, `原网关应已下线：${JSON.stringify(st1).slice(0, 120)}`);
console.log("ok  双进程接管：qq_connect 让位原网关 → 锁换主 → 原 server 存活但下线");

// -- 7. 收尾：stdin 关闭 → 网关优雅退出并释放锁 ------------------------------
server2.stdin.end();
const code2 = await new Promise((resolve) => server2.on("close", resolve));
assert.equal(code2, 0, `server2 应以 0 退出（stderr=${server2Err}）`);
assert.ok(!existsSync(lockFile), "持锁方退出时应释放单实例锁");
server.stdin.end();
const code = await new Promise((resolve) => server.on("close", resolve));
assert.equal(code, 0, `mcp-server 应以 0 退出（stderr=${serverErr}）`);
console.log("ok  双进程优雅退出，锁已释放");

console.log("\nBUNDLE E2E PASSED");
