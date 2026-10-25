import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPath,
  ensureExampleConfig,
  loadConfig,
  migrateConfig,
  normalizeConfig,
  saveAllowFrom,
  saveConfig,
} from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "qqbot-config-"));
const p = join(dir, "config.json");

const VALID = { appId: "102345678", appSecret: "sec-ret" };

test("normalizeConfig: 非 JSON 对象拒绝", () => {
  assert.equal(normalizeConfig(null, p).ok, false);
  assert.equal(normalizeConfig("x", p).ok, false);
});

test("normalizeConfig: 缺 appId / appSecret 各自报错", () => {
  const r = normalizeConfig({ appSecret: "s" }, p);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /appId/);
  const r2 = normalizeConfig({ appId: "a" }, p);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.error, /appSecret/);
});

test("normalizeConfig: YOUR_ 占位符视为未配置", () => {
  const r = normalizeConfig({ appId: "YOUR_QQBOT_APP_ID", appSecret: "x" }, p);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /真实的/);
});

test("normalizeConfig: v1 默认值（forwardTerminal 关、selfHeal 开、autoConnect 开）", () => {
  const r = normalizeConfig(VALID, p);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.config.forwardTerminal, false, "终端镜像默认关（用户锁定决策）");
  assert.equal(r.config.selfHeal, true);
  assert.equal(r.config.markdownSupport, false);
  assert.equal(r.config.allowGroup, false);
  assert.equal(r.config.autoConnect, true, "autoConnect 默认开（0.3.0，用户 2026-10-25 要求跨会话免手动连）");
  assert.equal(r.config.idleNotify, true, "空闲桌面通知默认开（0.3.2）");
  assert.equal(r.config.idleAck, true, "空闲 QQ 回执默认开（0.3.2）");
  assert.deepEqual(r.config.allowFrom, []);
  assert.deepEqual(r.config.allowGroupFrom, [], "群开放名单默认空（0.4.3）");
});

test("normalizeConfig: 显式 autoConnect:false 被保留（迁移后用户仍可关）", () => {
  const r = normalizeConfig({ ...VALID, autoConnect: false }, p);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.config.autoConnect, false);
});

test("normalizeConfig: 显式值被保留", () => {
  const r = normalizeConfig(
    { ...VALID, forwardTerminal: true, selfHeal: false, allowFrom: [" o1 ", "", "o2"], allowGroupFrom: [" g1 ", "", "g2"], autoConnect: true },
    p,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.config.forwardTerminal, true);
  assert.equal(r.config.selfHeal, false);
  assert.equal(r.config.autoConnect, true);
  assert.deepEqual(r.config.allowFrom, ["o1", "o2"]);
  assert.deepEqual(r.config.allowGroupFrom, ["g1", "g2"], "群开放名单同 allowFrom 清洗规则");
});

test("normalizeConfig: maxChunkChars 钳制到 [500, 4800]", () => {
  const cases: [unknown, number][] = [
    [10, 500],
    [99999, 4800],
    ["junk", 4500],
    [undefined, 4500],
    [2000, 2000],
  ];
  for (const [input, want] of cases) {
    const r = normalizeConfig({ ...VALID, maxChunkChars: input }, p);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.config.maxChunkChars, want, `maxChunkChars=${String(input)}`);
  }
});

test("loadConfig: 文件不存在报错", () => {
  const r = loadConfig(join(dir, "nope.json"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /不存在/);
});

test("loadConfig: 损坏 JSON 报错", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{oops");
  const r = loadConfig(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /解析失败/);
});

test("saveConfig: 补丁合并且不丢已有字段", () => {
  assert.equal(saveConfig({ appId: VALID.appId, appSecret: VALID.appSecret }, p).ok, true);
  assert.equal(saveConfig({ allowFrom: ["openid-1"] }, p).ok, true);
  const r = loadConfig(p);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.config.appId, VALID.appId);
  assert.deepEqual(r.config.allowFrom, ["openid-1"]);
});

test("saveAllowFrom: 归一化并持久化", () => {
  assert.equal(saveAllowFrom([" a ", 0, "b"], p).ok, true);
  const r = loadConfig(p);
  if (r.ok) assert.deepEqual(r.config.allowFrom, ["a", "0", "b"]);
});

test("ensureExampleConfig: 只创建一次", () => {
  const q = join(dir, "example.json");
  assert.equal(ensureExampleConfig(q).created, true);
  assert.equal(ensureExampleConfig(q).created, false);
  const raw = JSON.parse(readFileSync(q, "utf8"));
  assert.equal(raw.forwardTerminal, false);
  assert.equal(raw.selfHeal, true);
  assert.ok(String(raw.appId).startsWith("YOUR_"));
});

test("configPath: 环境变量覆盖", () => {
  const saved = process.env.ZCODE_QQBOT_CONFIG;
  try {
    process.env.ZCODE_QQBOT_CONFIG = "/tmp/qqbot-override.json";
    assert.equal(configPath(), "/tmp/qqbot-override.json");
  } finally {
    if (saved === undefined) delete process.env.ZCODE_QQBOT_CONFIG;
    else process.env.ZCODE_QQBOT_CONFIG = saved;
  }
});

test("migrateConfig: 0.2.x 旧文件（autoConnect:false 是旧默认落盘，非用户选择）→ 迁到 true", () => {
  const q = join(dir, "old.json");
  writeFileSync(q, JSON.stringify({ appId: "1", appSecret: "s", allowFrom: ["o1"], autoConnect: false, selfHeal: true }));
  migrateConfig(q);
  const raw = JSON.parse(readFileSync(q, "utf8"));
  assert.equal(raw.configVersion, 1, "应打上迁移标记");
  assert.equal(raw.autoConnect, true, "旧默认 false 应翻成新默认 true");
  assert.deepEqual(raw.allowFrom, ["o1"], "其余字段不得动");
  assert.equal(loadConfig(q).ok && loadConfig(q).config?.autoConnect, true);
});

test("migrateConfig: 已迁移（configVersion=1）的文件不动，显式 false 保留", () => {
  const q = join(dir, "migrated.json");
  writeFileSync(q, JSON.stringify({ appId: "1", appSecret: "s", autoConnect: false, configVersion: 1 }));
  migrateConfig(q);
  const raw = JSON.parse(readFileSync(q, "utf8"));
  assert.equal(raw.autoConnect, false, "用户显式关的不得被翻");
});

test("migrateConfig: 缺失/损坏文件静默不报错", () => {
  migrateConfig(join(dir, "不存在.json"));
  const bad = join(dir, "bad2.json");
  writeFileSync(bad, "{oops");
  migrateConfig(bad);
});
