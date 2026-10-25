/**
 * 扫码配对（M3，ADR-0003）：@tencent-connect/qqbot-connector 包装。
 * 实测 API（1.2.0 d.ts）：只能用回调风格 startQrConnect——
 * Promise 风格 qrConnect() 会强制往控制台打印二维码，污染 MCP stdio，不可用。
 * 二维码同时产出 SVG（内联渲染成图片，主展示渠道）和 utf8 纯文本（等宽兜底）；
 * 不用 terminal 渲染器：其 ANSI 色码经过 MCP 客户端会被转写成 "[object Object]"。
 * 成功回传 {appId, appSecret} → 立即写 config.json（经 onCredentials 回调）。
 */

import { randomUUID } from "node:crypto";
import { logLine } from "./log.ts";

export interface PairSession {
  pairingId: string;
  url?: string;
  status: "starting" | "pending" | "success" | "failed";
  error?: string;
  appId?: string;
  dispose?: () => void;
}

export interface PairManagerOptions {
  /** 扫码成功后回调（网关用它写配置并热更新）。 */
  onCredentials: (appId: string, appSecret: string) => Promise<void>;
}

export class PairManager {
  private readonly sessions = new Map<string, PairSession>();

  constructor(private readonly opts: PairManagerOptions) {}

  /**
   * 发起扫码配对：创建会话、等二维码 URL 就绪（≤10s），返回 {pairingId, url, ascii}。
   * 扫码结果异步到达，用 pending(pairingId) 轮询。
   */
  async start(): Promise<
    { ok: true; pairingId: string; url: string; ascii: string; svg: string } | { ok: false; error: string }
  > {
    let connector: any;
    let qrcode: any;
    try {
      [connector, qrcode] = await Promise.all([
        import("@tencent-connect/qqbot-connector"),
        import("qrcode"),
      ]);
    } catch (err) {
      return { ok: false, error: `配对依赖加载失败：${(err as Error).message}` };
    }

    const pairingId = randomUUID();
    const session: PairSession = { pairingId, status: "starting" };
    this.sessions.set(pairingId, session);

    const urlReady = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("二维码 URL 超时未就绪")), 10_000);
      session.dispose = connector.startQrConnect(
        {
          onSuccess: (credentials: Array<{ appId?: string; appSecret?: string }>) => {
            const cred = (credentials ?? []).find((c) => c?.appId && c?.appSecret);
            if (!cred) {
              session.status = "failed";
              session.error = "扫码成功但凭据不完整";
              logLine("pair-failed", { pairingId, error: session.error });
              return;
            }
            session.status = "success";
            session.appId = cred.appId;
            logLine("pair-success", { pairingId, appId: cred.appId });
            void this.opts
              .onCredentials(cred.appId!, cred.appSecret!)
              .catch((err) => logLine("pair-save-error", { pairingId, error: (err as Error).message }));
          },
          onFailure: (error: Error) => {
            session.status = "failed";
            session.error = error.message;
            logLine("pair-failed", { pairingId, error: error.message });
          },
          onQrDisplayed: (url: string) => {
            clearTimeout(timer);
            session.url = url;
            session.status = "pending";
            resolve(url);
          },
        },
        { displayQrCodeToConsole: false, source: "zcode-qqbot" },
      );
    });

    let url: string;
    try {
      url = await urlReady;
    } catch (err) {
      session.dispose?.();
      this.sessions.delete(pairingId);
      return { ok: false, error: (err as Error).message };
    }

    const [ascii, svg] = await Promise.all([
      qrcode.toString(url, { type: "utf8" }),
      qrcode.toString(url, { type: "svg", margin: 1 }),
    ]);
    return { ok: true, pairingId, url, ascii: String(ascii).trim(), svg: String(svg) };
  }

  /** 轮询配对结果（500ms 步进）。 */
  async pending(
    pairingId: string,
    timeoutSec = 120,
  ): Promise<{ status: "pending" | "success" | "failed" | "unknown"; appId?: string; error?: string }> {
    const timeout = Math.min(Math.max(1, Math.round(timeoutSec)), 120) * 1000;
    const deadline = Date.now() + timeout;
    for (;;) {
      const session = this.sessions.get(pairingId);
      if (!session) return { status: "unknown" };
      if (session.status === "success" || session.status === "failed") {
        const out: { status: string; appId?: string; error?: string } = { status: session.status, appId: session.appId };
        if (session.error) out.error = session.error;
        return out as ReturnType<PairManager["pending"]>;
      }
      if (Date.now() >= deadline) return { status: "pending" };
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  status(): Record<string, unknown> {
    const active = [...this.sessions.values()].filter((s) => s.status === "starting" || s.status === "pending").at(-1);
    return active
      ? { activePairing: { pairingId: active.pairingId, url: active.url } }
      : { activePairing: null };
  }
}
