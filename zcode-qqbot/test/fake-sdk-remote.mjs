/**
 * 可远程驱动的 Fake QQ SDK（bundle-e2e 用）：在 ZCODE_QQBOT_FAKE_PORT 端口
 * 起一个 127.0.0.1 控制面，让 harness 从外部进程注入来信 / 读取出站记录。
 *   POST /emit   {ctx?, msg?}   → 触发 message 事件（msg 默认一条 c2c 来信）
 *   POST /ready  {}             → 触发 ready 事件
 *   GET  /sent                  → 出站记录 JSON
 *   GET  /health                → 活性
 * 不设 ZCODE_QQBOT_FAKE_PORT 时不监听，行为退化为普通 fake-sdk。
 */

import http from "node:http";

export class QQBot {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.sent = [];
    this.started = false;
    this.stopped = false;
    (globalThis.__qqBotFake ??= { instances: [] }).instances.push(this);
    this.#listen();
  }

  #listen() {
    const port = Number(process.env.ZCODE_QQBOT_FAKE_PORT || 0);
    if (!port) return;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
        const json = (code, payload) => {
          const s = JSON.stringify(payload);
          res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
          res.end(s);
        };
        if (req.method === "POST" && req.url === "/emit") {
          const msg =
            body.msg ??
            {
              kind: "c2c",
              senderId: "owner-1",
              content: "remote ping",
              messageId: `m-${Date.now()}`,
              replyTarget: null,
            };
          if (msg.replyTarget == null) {
            msg.replyTarget = { scope: msg.kind === "group" ? "group" : "c2c", targetId: msg.senderId, msgId: msg.messageId };
          }
          void this.emitMessage(body.ctx ?? {}, msg);
          json(200, { ok: true });
        } else if (req.method === "POST" && req.url === "/ready") {
          this.emitReady();
          json(200, { ok: true });
        } else if (req.method === "GET" && req.url === "/sent") {
          json(200, this.sent);
        } else if (req.method === "GET" && req.url === "/health") {
          json(200, { ok: true });
        } else {
          json(404, { ok: false });
        }
      });
    });
    server.listen(port, "127.0.0.1");
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  off(event, handler) {
    if (this.handlers.get(event) === handler) this.handlers.delete(event);
    return this;
  }

  async start(signal) {
    this.started = true;
    await new Promise((resolve) => {
      if (!signal || signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  stop() {
    this.stopped = true;
  }

  async sendText(target, content) {
    this.sent.push({ target, content });
    return { id: `msg-${this.sent.length}` };
  }

  async emitMessage(ctx, msg) {
    const handler = this.handlers.get("message");
    if (handler) await handler(ctx, msg);
  }

  emitReady() {
    const handler = this.handlers.get("ready");
    if (handler) handler({});
  }
}
