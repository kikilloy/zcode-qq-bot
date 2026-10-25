import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, breakStaleLock, lockPath, readLock, releaseLock } from "../src/lock.ts";

const dir = mkdtempSync(join(tmpdir(), "qqbot-lock-"));
const p = join(dir, "l.lock");

test("lock: 空闲时可获取，写入 port/sessionId", () => {
  const r = acquireLock({ path: p, pid: 100, port: 8765, sessionId: "sess-a" });
  assert.equal(r.ok, true);
  const holder = readLock(p);
  assert.equal(holder?.pid, 100);
  assert.equal(holder?.port, 8765);
  assert.equal(holder?.sessionId, "sess-a");
});

test("lock: 活锁持有期间拒绝，holder 带完整信息", () => {
  const r = acquireLock({ path: p, pid: 200, isAlive: () => true });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.holder.pid, 100);
    assert.equal(r.holder.port, 8765);
    assert.equal(r.holder.sessionId, "sess-a");
  }
});

test("lock: 同 pid 重复获取允许", () => {
  const r = acquireLock({ path: p, pid: 100 });
  assert.equal(r.ok, true);
});

test("lock: 陈旧锁（死 pid）被回收", () => {
  const r = acquireLock({ path: p, pid: 300, isAlive: () => false });
  assert.equal(r.ok, true);
  assert.equal(readLock(p)?.pid, 300);
});

test("lock: release 只清除自己的锁", () => {
  releaseLock({ path: p, pid: 999 });
  assert.equal(readLock(p)?.pid, 300, "非持有者不得清除");
  releaseLock({ path: p, pid: 300 });
  assert.equal(readLock(p), undefined);
});

test("lock: 损坏锁文件视为无锁", () => {
  const bad = join(dir, "bad.lock");
  writeFileSync(bad, "not json");
  assert.equal(readLock(bad), undefined);
  const r = acquireLock({ path: bad, pid: 7 });
  assert.equal(r.ok, true);
});

test("lockPath: 环境变量覆盖", () => {
  const saved = process.env.ZCODE_QQBOT_LOCK;
  try {
    process.env.ZCODE_QQBOT_LOCK = "/tmp/qqbot-lock-override.json";
    assert.equal(lockPath(), "/tmp/qqbot-lock-override.json");
  } finally {
    if (saved === undefined) delete process.env.ZCODE_QQBOT_LOCK;
    else process.env.ZCODE_QQBOT_LOCK = saved;
  }
});

test("lock: breakStaleLock 只拆指定 pid 的残留锁", () => {
  const stale = join(dir, "stale.lock");
  writeFileSync(stale, JSON.stringify({ pid: 424242, host: "h", port: 59999, at: 1 }));
  assert.equal(breakStaleLock(111111, { path: stale }), false, "pid 不符不得拆");
  assert.equal(readLock(stale)?.pid, 424242);
  assert.equal(breakStaleLock(424242, { path: stale }), true, "pid 相符应拆除");
  assert.equal(readLock(stale), undefined);
  assert.equal(breakStaleLock(424242, { path: stale }), false, "无锁返回 false");
});
