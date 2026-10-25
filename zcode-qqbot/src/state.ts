/**
 * 最后回复目标的持久化：重启后恢复被动回复窗口（msg_id 60 分钟内仍可用）。
 * 状态文件落 ~/.zcode/qqbot/state.json。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PASSIVE_REPLY_TTL_MS } from "./core.ts";

export type Scope = "c2c" | "group";

export interface PersistedTarget {
  scope: Scope;
  targetId: string;
  /** 来信消息 id；只在 TTL 窗口内可用于被动回复。 */
  msgId?: string;
  /** 该目标最后一次出现的时间（epoch ms）。 */
  at: number;
}

export function statePath(): string {
  return process.env.ZCODE_QQBOT_STATE || path.join(os.homedir(), ".zcode", "qqbot", "state.json");
}

export function loadState(filePath: string = statePath()): PersistedTarget | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return undefined;
    const scope = raw.scope === "group" ? "group" : raw.scope === "c2c" ? "c2c" : undefined;
    const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
    if (!scope || !targetId) return undefined;
    const loaded: PersistedTarget = {
      scope,
      targetId,
      at: typeof raw.at === "number" ? raw.at : 0,
    };
    if (typeof raw.msgId === "string" && raw.msgId) loaded.msgId = raw.msgId;
    return loaded;
  } catch {
    return undefined;
  }
}

export function saveState(t: PersistedTarget, filePath: string = statePath()): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(t)}\n`, { mode: 0o600 });
  } catch {
    // 目标持久化尽力而为。
  }
}

/**
 * 只在 msg_id 仍可用于被动回复时返回它；过期后平台会拒绝，
 * 调用方必须改发主动消息（不带 msg_id）。
 */
export function freshMsgId(
  t: PersistedTarget | undefined,
  now: number,
  ttlMs: number = PASSIVE_REPLY_TTL_MS,
): string | undefined {
  if (!t || !t.msgId) return undefined;
  return now - t.at <= ttlMs ? t.msgId : undefined;
}
