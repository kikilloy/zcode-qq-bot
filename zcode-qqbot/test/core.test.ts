import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QQ_MARKER,
  DEFAULT_MAX_CHUNK_CHARS,
  PASSIVE_REPLY_LIMIT,
  ReplyBudget,
  budgetWarning,
  chunkText,
  isInjected,
  markInjected,
} from "../src/core.ts";

test("常量与平台配额一致", () => {
  assert.equal(QQ_MARKER, "[QQ]");
  assert.equal(PASSIVE_REPLY_LIMIT, 4);
  assert.equal(DEFAULT_MAX_CHUNK_CHARS, 4500);
});

test("chunkText: 短文本直通", () => {
  assert.deepEqual(chunkText("hi", 100), ["hi"]);
  assert.deepEqual(chunkText("", 100), []);
});

test("chunkText: 每片不超限且内容保真", () => {
  const para = "x".repeat(300);
  const text = Array.from({ length: 20 }, () => para).join("\n\n");
  const chunks = chunkText(text, 1000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1000, `chunk too long: ${c.length}`);
  // 内容保真（边界空白折叠除外）。
  assert.equal(chunks.join("").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("chunkText: 优先段落边界", () => {
  const text = `${"a".repeat(100)}\n\n${"b".repeat(100)}`;
  const chunks = chunkText(text, 150);
  assert.equal(chunks[0], "a".repeat(100));
  assert.equal(chunks[1], "b".repeat(100));
});

test("chunkText: 不可断行内容硬切", () => {
  const text = "c".repeat(2500);
  const chunks = chunkText(text, 1000);
  assert.deepEqual(chunks.map((c) => c.length), [1000, 1000, 500]);
});

test("ReplyBudget: 每条来信恰好允许 4 次被动回复", () => {
  const b = new ReplyBudget(4, 60 * 60 * 1000, () => 0);
  for (let i = 0; i < 4; i++) {
    assert.equal(b.check("m1").allowed, true, `第 ${i + 1} 条应放行`);
    b.record("m1");
  }
  const after = b.check("m1");
  assert.equal(after.allowed, false);
  assert.equal(after.remaining, 0);
  // 不同来信有独立配额。
  assert.equal(b.check("m2").allowed, true);
});

test("ReplyBudget: TTL 过期后重置", () => {
  let now = 0;
  const b = new ReplyBudget(4, 1000, () => now);
  for (let i = 0; i < 4; i++) {
    b.record("m1");
  }
  assert.equal(b.check("m1").allowed, false);
  now = 1001;
  assert.equal(b.check("m1").allowed, true);
});

test("budgetWarning: 余量分级", () => {
  assert.equal(budgetWarning(4, true), "none");
  assert.equal(budgetWarning(2, true), "none");
  assert.equal(budgetWarning(1, true), "low");
  assert.equal(budgetWarning(0, true), "low");
  assert.equal(budgetWarning(0, false), "exhausted");
  assert.equal(budgetWarning(3, false), "exhausted");
});

test("注入标记可往返识别", () => {
  const marked = markInjected("hello from qq");
  assert.ok(isInjected(marked));
  assert.ok(!isInjected("hello from terminal"));
  assert.ok(isInjected("   [QQ] leading spaces"));
});
