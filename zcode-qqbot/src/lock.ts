/**
 * QQ 网关连接的单实例锁。
 *
 * QQ 每个 bot 只允许一条网关连接，两个 zcode 会话同时连会互相顶掉。
 * 锁保证同时只有一个网关真正连 QQ；死进程的陈旧锁自动回收。
 * 相比裸文件锁：LockInfo 增加 port（控制平面端口，钩子靠它找持锁网关）
 * 与 sessionId（持锁的 zcode 会话，终端镜像只镜像持锁会话）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LockInfo {
  pid: number;
  host: string;
  /** 持锁网关的控制平面端口（127.0.0.1）。 */
  port?: number;
  /** 持锁网关所属的 zcode 会话 id。 */
  sessionId?: string;
  /** 持锁进程工作目录（识别"是哪个对话"的线索）。 */
  cwd?: string;
  at: number;
}

export type AcquireResult = { ok: true; info: LockInfo } | { ok: false; holder: LockInfo };

export interface LockOptions {
  path?: string;
  pid?: number;
  host?: string;
  port?: number;
  sessionId?: string;
  cwd?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export function lockPath(): string {
  return process.env.ZCODE_QQBOT_LOCK || path.join(os.homedir(), ".zcode", "qqbot", "lock.json");
}

/** pid 进程是否存活（EPERM 也算存在）。 */
export function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function readLock(p: string = lockPath()): LockInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    if (raw && typeof raw.pid === "number") {
      return {
        pid: raw.pid,
        host: typeof raw.host === "string" ? raw.host : "unknown",
        port: typeof raw.port === "number" ? raw.port : undefined,
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
        at: typeof raw.at === "number" ? raw.at : 0,
      };
    }
  } catch {
    // 锁缺失或损坏：视为无锁。
  }
  return undefined;
}

/**
 * 尝试成为持锁网关。
 * - 无锁 / 陈旧锁 / 锁本来就是自己的 → 成功
 * - 活锁且属于别的 pid → 拒绝，返回持锁者
 */
export function acquireLock(opts: LockOptions = {}): AcquireResult {
  const p = opts.path ?? lockPath();
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? os.hostname();
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const info: LockInfo = { pid, host, port: opts.port, sessionId: opts.sessionId, cwd: opts.cwd, at: (opts.now ?? Date.now)() };

  for (let attempt = 0; attempt < 3; attempt++) {
    const holder = readLock(p);
    if (holder) {
      if (holder.pid === pid) return { ok: true, info: holder };
      if (isAlive(holder.pid)) return { ok: false, holder };
      // 陈旧持锁者：回收后重试。
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // 落到重试
      }
      continue;
    }
    // 读不到持锁者：清掉损坏残留，让 wx 写入能成功。
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    } catch {
      // 落到重试
    }
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${JSON.stringify(info)}\n`, { flag: "wx", mode: 0o600 });
      return { ok: true, info };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") continue; // 抢锁输给了竞态
      const raced = readLock(p);
      return { ok: false, holder: raced ?? info };
    }
  }

  const finalHolder = readLock(p);
  if (finalHolder && finalHolder.pid === pid) return { ok: true, info: finalHolder };
  return { ok: false, holder: finalHolder ?? info };
}

/** 释放锁，仅当自己持有时。 */
export function releaseLock(opts: LockOptions = {}): void {
  const p = opts.path ?? lockPath();
  const pid = opts.pid ?? process.pid;
  const holder = readLock(p);
  if (!holder || holder.pid !== pid) return;
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // 尽力而为
  }
}

/**
 * 强制拆除残留锁（0.4.1）：仅当锁仍指向给定 pid 时移除。场景：网关进程被硬杀
 * （如整退 zcode）时收尾没机会跑，之后 Windows 复用该 PID，让 isAlive 误判
 * "持锁者还活着"。调用方必须先以"端口无监听（ECONNREFUSED）"证实网关确死
 * （见 gateway.connect 的接管探测）。
 */
export function breakStaleLock(holderPid: number, opts: LockOptions = {}): boolean {
  const p = opts.path ?? lockPath();
  const holder = readLock(p);
  if (!holder || holder.pid !== holderPid) return false;
  try {
    fs.rmSync(p, { force: true });
    return true;
  } catch {
    return false;
  }
}
