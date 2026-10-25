/**
 * 控制平面（M3，ADR-0004）：网关在 127.0.0.1:<随机端口> 上的 HTTP 面。
 * 钩子脚本（独立短命进程）靠锁文件里的 port 寻址：
 *   GET  /health           钩子快速探测"持锁网关是否活着"（pid 与锁同源）
 *   POST /claim            Stop/UserPromptSubmit 钩子取注入/自愈决策（矩阵在 gateway.claim）
 *   POST /terminal-mirror  UserPromptSubmit 钩子上报终端输入（标记终端回合 + 可选镜像）
 *   POST /shutdown         其他会话 qq_connect 接管时请持锁方让位（0.3.1；先回包再断开）
 * 只绑回环；凭据不出网关。请求体上限 64KB，非法请求一律快速 4xx。
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { logLine } from "./log.ts";
import type { ClaimResult } from "./gateway.ts";

export interface ControlPlaneBackend {
  health(): Record<string, unknown>;
  claim(body: { sessionId?: string; stopHookActive?: boolean; via?: string }): ClaimResult;
  mirror(body: { sessionId?: string; text?: string }): Promise<{ ok: boolean; mirrored: boolean; reason?: string }>;
  /** 请持锁网关让位（0.3.1 接管用）：断开 QQ、释放锁，进程继续存活服务本会话。 */
  shutdown(reason?: string): void;
}

export interface ControlPlane {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

export async function startControlPlane(backend: ControlPlaneBackend): Promise<ControlPlane> {
  const server = http.createServer((req, res) => {
    // 钩子可能在拿到响应前就超时退出（socket 销毁后 sendJson 抛错）——绝不能让
    // 写响应失败演化成未处理 rejection 打死整个网关进程。
    void (async () => {
      try {
        const url = req.url ?? "/";
        if (req.method === "GET" && url === "/health") {
          sendJson(res, 200, backend.health());
          return;
        }
        if (req.method === "POST" && url === "/shutdown") {
          // 先回包再让位：接管方拿到 200 才去抢锁，避免它等一个正在收尾的进程。
          sendJson(res, 200, { ok: true });
          backend.shutdown("remote-takeover");
          return;
        }
        if (req.method === "POST" && (url === "/claim" || url === "/terminal-mirror")) {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as Record<string, unknown>;
          } catch {
            sendJson(res, 400, { ok: false, error: "bad-json" });
            return;
          }
          const result =
            url === "/claim"
              ? backend.claim({ sessionId: str(body.sessionId), stopHookActive: body.stopHookActive === true, via: str(body.via) })
              : await backend.mirror({ sessionId: str(body.sessionId), text: str(body.text) });
          sendJson(res, 200, result);
          return;
        }
        sendJson(res, 404, { ok: false, error: "not-found" });
      } catch {
        try {
          sendJson(res, 500, { ok: false, error: "internal" });
        } catch {
          // 客户端已断开：响应写不出去就算了
        }
      }
    })().catch(() => {
      // 最后防线：任何遗漏异常吞掉（网关是会话期常驻进程）
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  logLine("control-plane-listening", { port });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
