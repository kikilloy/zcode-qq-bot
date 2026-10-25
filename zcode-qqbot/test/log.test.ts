import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logLine, logPath } from "../src/log.ts";

const dir = mkdtempSync(join(tmpdir(), "qqbot-log-"));
const p = join(dir, "log.jsonl");

test("logLine: 写出可解析的 JSONL，字段合并且 t/event 不被覆盖", () => {
  logLine("msg.in", { from: "openid-1", preview: "你好" }, p);
  logLine("gateway.start", { port: 8765 }, p);
  const lines = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, "msg.in");
  assert.equal(lines[0].from, "openid-1");
  assert.equal(lines[0].preview, "你好");
  assert.ok(typeof lines[0].t === "string" && lines[0].t.includes("T"));
  assert.equal(lines[1].event, "gateway.start");
  assert.equal(lines[1].port, 8765);
});

test("logLine: data 键与 t/event 冲突时保留框架字段", () => {
  const q = join(dir, "collision.jsonl");
  logLine("e", { event: "fake", t: "fake" }, q);
  const line = JSON.parse(readFileSync(q, "utf8"));
  assert.equal(line.event, "e");
  assert.notEqual(line.t, "fake");
});

test("logLine: 超过 2MB 轮转清空", () => {
  const q = join(dir, "big.jsonl");
  writeFileSync(q, "x".repeat(2 * 1024 * 1024 + 1));
  logLine("after.rotate", {}, q);
  const content = readFileSync(q, "utf8").trim();
  assert.equal(content.split("\n").length, 1);
  assert.equal(JSON.parse(content).event, "after.rotate");
  assert.ok(statSync(q).size < 1024, "轮转后文件应只剩一行");
});

test("logLine: 无 data 也可写", () => {
  const q = join(dir, "bare.jsonl");
  logLine("bare.event", undefined, q);
  assert.ok(existsSync(q));
  const line = JSON.parse(readFileSync(q, "utf8"));
  assert.equal(line.event, "bare.event");
});

test("logPath: 环境变量覆盖", () => {
  const saved = process.env.ZCODE_QQBOT_LOG;
  try {
    process.env.ZCODE_QQBOT_LOG = "/tmp/qqbot-log-override.jsonl";
    assert.equal(logPath(), "/tmp/qqbot-log-override.jsonl");
  } finally {
    if (saved === undefined) delete process.env.ZCODE_QQBOT_LOG;
    else process.env.ZCODE_QQBOT_LOG = saved;
  }
});
