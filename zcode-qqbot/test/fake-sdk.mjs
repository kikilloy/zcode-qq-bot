/**
 * Fake QQ Bot SDK（flow-harness 用）。
 * 记录出站调用、允许测试注入来信；实例挂 globalThis 共享（绕开模块身份问题）。
 */

export class QQBot {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.sent = [];
    this.started = false;
    this.stopped = false;
    this.failPassive = false;
    (globalThis.__qqBotFake ??= { instances: [] }).instances.push(this);
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
    if (this.failPassive && target.msgId) throw new Error("simulated passive send failure");
    this.sent.push({ target, content });
    return { id: `msg-${this.sent.length}` };
  }

  async emitMessage(ctx, msg) {
    const handler = this.handlers.get("message");
    if (handler) await handler(ctx, msg);
  }

  emitRawEvent(ctx) {
    const handler = this.handlers.get("rawEvent");
    if (handler) handler(ctx);
  }

  emitReady() {
    const handler = this.handlers.get("ready");
    if (handler) handler({});
  }
}
