import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshMsgId, loadState, saveState, statePath } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "qqbot-state-"));
const p = join(dir, "state.json");

test("loadState: 文件不存在返回 undefined", () => {
  assert.equal(loadState(join(dir, "nope.json")), undefined);
});

test("loadState: 损坏 JSON 返回 undefined", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{oops");
  assert.equal(loadState(bad), undefined);
});

test("loadState: 缺关键字段返回 undefined", () => {
  const q = join(dir, "partial.json");
  writeFileSync(q, JSON.stringify({ scope: "c2c" }));
  assert.equal(loadState(q), undefined);
});

test("saveState/loadState: 往返一致", () => {
  const t = { scope: "c2c" as const, targetId: "openid-9", msgId: "msg-42", at: 1234567 };
  saveState(t, p);
  assert.deepEqual(loadState(p), t);
});

test("saveState/loadState: 无 msgId 也合法", () => {
  const t = { scope: "group" as const, targetId: "g-1", at: 1 };
  saveState(t, p);
  assert.deepEqual(loadState(p), t);
});

test("freshMsgId: TTL 语义", () => {
  const t = { scope: "c2c" as const, targetId: "u", msgId: "m", at: 1000 };
  assert.equal(freshMsgId(undefined, 99999), undefined, "无目标");
  assert.equal(freshMsgId({ ...t, msgId: undefined }, 99999), undefined, "无 msgId");
  assert.equal(freshMsgId(t, 1000 + 60 * 60 * 1000), "m", "恰好到 TTL 仍有效（<=）");
  assert.equal(freshMsgId(t, 1000 + 60 * 60 * 1000 + 1), undefined, "过期");
});

test("statePath: 环境变量覆盖", () => {
  const saved = process.env.ZCODE_QQBOT_STATE;
  try {
    process.env.ZCODE_QQBOT_STATE = "/tmp/qqbot-state-override.json";
    assert.equal(statePath(), "/tmp/qqbot-state-override.json");
  } finally {
    if (saved === undefined) delete process.env.ZCODE_QQBOT_STATE;
    else process.env.ZCODE_QQBOT_STATE = saved;
  }
});
