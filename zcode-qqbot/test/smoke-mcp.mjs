// MCP stdio 冒烟（M1 验收）：initialize → tools/list → tools/call qq_ping → 断言 pong。
// 在插件根目录跑：node test/smoke-mcp.mjs（需先 npm run build 出 dist/mcp-server.mjs）。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const server = spawn(process.execPath, ["dist/mcp-server.mjs"], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000).unref();
  });
}

const failures = [];
let text = "";
try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  if (init.error) failures.push(`initialize 失败：${init.error.message}`);
  if (init.result?.serverInfo?.name !== "zcode-qqbot") failures.push("serverInfo.name 不符");

  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  if (!list.result?.tools?.some((t) => t.name === "qq_ping")) failures.push("tools/list 缺 qq_ping");

  const call = await rpc("tools/call", { name: "qq_ping", arguments: {} });
  text = call.result?.content?.[0]?.text ?? "";
  if (!/^pong/.test(text)) failures.push(`qq_ping 返回异常：${text || JSON.stringify(call)}`);
} catch (error) {
  failures.push(`冒烟中断：${error.message}`);
}

server.kill();
if (failures.length) {
  console.error("SMOKE FAIL:", failures.join("；"));
  process.exit(1);
}
console.log("SMOKE PASS:", text || "(未执行到 tools/call)");
