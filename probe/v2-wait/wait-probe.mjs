// V0 探针 MCP 服务器：验证 zcode 客户端的工具超时与 progress 重置行为
// 工具 wait_probe(sleepMs, ping)：阻塞 sleepMs；ping=true 时每 15s 发 notifications/progress
// 所有入站消息原文落盘 requests.log（用于观察 _meta.progressToken 是否下发）
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const LOG = new URL("./requests.log", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const log = (tag, obj) => {
  try { appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), tag, ...obj }) + "\n"); } catch {}
};

const TOOLS = [{
  name: "wait_probe",
  description: "测试用：阻塞 sleepMs 毫秒后返回。ping=true 时每 15 秒上报一次 progress。",
  inputSchema: {
    type: "object",
    properties: {
      sleepMs: { type: "number", description: "阻塞毫秒数" },
      ping: { type: "boolean", description: "是否发送 progress 心跳" },
    },
    required: ["sleepMs"],
  },
}];

function reply(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}
function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function handleCall(params) {
  const args = (params?.arguments ?? {});
  const sleepMs = Math.min(Number(args.sleepMs) || 1000, 600000);
  const ping = args.ping !== false;
  const token = params?._meta?.progressToken;
  log("tools-call", { sleepMs, ping, hasProgressToken: token !== undefined, progressToken: token ?? null, metaKeys: Object.keys(params?._meta ?? {}) });
  const t0 = Date.now();
  let pings = 0;
  await new Promise((resolve) => {
    let iv = null;
    const done = () => { if (iv) clearInterval(iv); resolve(); };
    const timer = setTimeout(done, sleepMs);
    if (ping && token !== undefined) {
      iv = setInterval(() => {
        pings++;
        notify("notifications/progress", { progressToken: token, progress: Date.now() - t0, total: sleepMs, message: "waiting" });
      }, 15000);
    }
  });
  return `waited ${Date.now() - t0}ms, pings=${pings}, tokenSeen=${token !== undefined}`;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  if (msg.id === undefined) { log("notification", { method: msg.method, params: msg.params ?? null }); return; }
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      reply(msg.id, { result: { protocolVersion: typeof p.protocolVersion === "string" ? p.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "wait-probe", version: "0.0.1" } } });
      break;
    case "ping":
      reply(msg.id, { result: {} });
      break;
    case "tools/list":
      reply(msg.id, { result: { tools: TOOLS.map((t) => ({ ...t, _meta: { timeoutMs: 1800000 } })) } });
      break;
    case "tools/call":
      handleCall(p)
        .then((text) => reply(msg.id, { result: { content: [{ type: "text", text }] } }))
        .catch((e) => reply(msg.id, { result: { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true } }));
      break;
    default:
      reply(msg.id, { error: { code: -32601, message: `method not found: ${String(msg.method)}` } });
  }
});
rl.on("close", () => process.exit(0));
