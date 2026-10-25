/**
 * 结构化 JSONL 日志：每行一个 JSON 对象 {"t": iso, "event": "...", ...data}。
 * 超过 2MB 整体清空重来。文件 0600（可能含消息预览）。
 * 红线：调用方不得把 appSecret 写进日志。
 * 纯文本变参改为结构化事件便于 M3 网关排查；路径每次解析，方便测试与 env 覆盖。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

export function logPath(): string {
  return process.env.ZCODE_QQBOT_LOG || path.join(os.homedir(), ".zcode", "qqbot", "log.jsonl");
}

export function logLine(
  event: string,
  data?: Record<string, unknown>,
  filePath: string = logPath(),
): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const existed = fs.existsSync(filePath);
    if (existed && fs.statSync(filePath).size > MAX_BYTES) {
      fs.writeFileSync(filePath, "", { mode: 0o600 });
    }
    const line = JSON.stringify({ ...(data ?? {}), t: new Date().toISOString(), event });
    fs.appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
    if (!existed) {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // 尽力而为
      }
    }
  } catch {
    // 日志绝不弄断桥接。
  }
}
