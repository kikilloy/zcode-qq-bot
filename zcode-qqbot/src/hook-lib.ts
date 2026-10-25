/**
 * 钩子公共管道：stdin 事件 JSON、锁文件寻址、控制平面短超时 HTTP。
 *
 * 红线：钩子必须便宜——无锁文件/网关不可达 → 立即退出，
 * 绝不空转网络请求；任何异常吞掉后按空输出退出，钩子永远不能失败。
 * stdout 写入用回调式退出：Windows 管道是异步写，process.exit 前必须等 flush。
 */

import { readLock } from "./lock.ts";
import { EMPTY_OUTPUT } from "./continuation.ts";

/** 读完整 stdin 并解析为事件 JSON；解析失败/空输入返回 undefined（钩子直接退）。 */
export function readStdinJson(): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => {
      raw += c;
    });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(raw || "{}") as unknown;
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    process.stdin.on("error", () => resolve(undefined));
  });
}

/** 会话 id：stdin `session_id` 优先，退回 env（M0 实测三处都有，含未展开的 `${...}` 字面量要过滤）。 */
export function sessionIdOf(event: Record<string, unknown> | undefined): string | undefined {
  const fromStdin = event?.["session_id"];
  if (typeof fromStdin === "string" && fromStdin && !fromStdin.startsWith("${")) return fromStdin;
  for (const key of ["CLAUDE_SESSION_ID", "ZCODE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]) {
    const v = process.env[key];
    if (v && !v.startsWith("${")) return v;
  }
  return undefined;
}

/** 持锁网关的控制平面地址；无锁/无端口 → undefined（钩子立即退出）。 */
export function controlPlaneUrl(): string | undefined {
  const lock = readLock();
  if (!lock?.port || !Number.isInteger(lock.port) || lock.port <= 0 || lock.port > 65535) return undefined;
  return `http://127.0.0.1:${lock.port}`;
}

/**
 * 控制平面短超时 JSON 请求（只对 127.0.0.1 说话）。
 * 任何失败（超时/连接拒绝/非 2xx/非 JSON）返回 undefined，调用方据此退出。
 */
export async function controlPlaneFetch(
  base: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown | undefined> {
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) return undefined;
    return JSON.parse(await res.text()) as unknown;
  } catch {
    return undefined;
  }
}

/** 输出空 JSON 后退出（Stop 正常收尾路径，退出码必须 0）。 */
export function exitQuiet(): void {
  finishOutput(EMPTY_OUTPUT);
}

/** 完全静默退出（不写 stdout——UserPromptSubmit 对 stdout 语义敏感，空输出被忽略）。 */
export function exitSilent(): void {
  process.exit(0);
}

/** 写 stdout 并在 flush 回调里退出；500ms 兜底强退防止极端情况下挂死。 */
export function finishOutput(text: string): void {
  process.stdout.write(`${text}\n`, () => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
