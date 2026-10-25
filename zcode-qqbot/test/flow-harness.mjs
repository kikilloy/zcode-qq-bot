/**
 * 网关 + 控制平面离线全流程 harness（M3），
 * 覆盖 design.md §7：鉴权、去重、配额降级、锁互斥、绑定态 + claim 决策四象限 + 控制平面 HTTP。
 * Run: node test/flow-harness.mjs（需 ZCODE_QQBOT_SDK 指向 fake-sdk.mjs——本文件自设）
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

const here = dirname(fileURLToPath(import.meta.url));

const home = mkdtempSync(join(tmpdir(), "qqbot-flow-"));
const configFile = join(home, "config.json");
writeFileSync(
  configFile,
  JSON.stringify({
    appId: "123456",
    appSecret: "s3cret",
    markdownSupport: false,
    allowFrom: ["owner-1"],
    maxChunkChars: 500,
    forwardTerminal: true,
    allowGroup: false,
    autoConnect: true,
    selfHeal: true,
  }),
);
process.env.ZCODE_QQBOT_CONFIG = configFile;
process.env.ZCODE_QQBOT_STATE = join(home, "state.json");
process.env.ZCODE_QQBOT_LOCK = join(home, "lock.json");
process.env.ZCODE_QQBOT_LOG = join(home, "log.jsonl");
process.env.ZCODE_QQBOT_SDK = pathToFileURL(join(here, "fake-sdk.mjs")).href;
globalThis.__qqBotFake = { instances: [] };

const { Gateway } = await import("../src/gateway.ts");
const { startControlPlane } = await import("../src/control-plane.ts");

// -- 0. 真 SDK 可加载（离线，仅模块解析） --------------------------------
const realSdk = await import("@tencent-connect/qqbot-nodejs");
assert.equal(typeof realSdk.QQBot, "function", "真 SDK 应可 import 且导出 QQBot");
console.log("ok  真 SDK 可加载（QQBot:", typeof realSdk.QQBot + "）");

// -- 1. autoConnect 启动：网关起传输、锁落盘带 port/sessionId ------------
const gw = new Gateway({ sessionId: "sess-A", pid: 100, notify: () => {} });
const cp = await startControlPlane(gw);
gw.setPort(cp.port);
await gw.init();
const bot = globalThis.__qqBotFake.instances.at(-1);
assert.ok(bot, "autoConnect 应构造 fake QQBot");
assert.ok(bot.started, "fake QQBot 应已 start");
bot.emitReady();
assert.ok(gatewayIs(gw, "running"), "网关应处于 running");
const lockRaw = JSON.parse(readFileSync(join(home, "lock.json"), "utf8"));
assert.equal(lockRaw.pid, 100);
assert.equal(lockRaw.port, cp.port, "锁文件应带控制平面端口");
assert.equal(lockRaw.sessionId, "sess-A");
console.log("ok  autoConnect 启动网关，锁落盘 {pid, port, sessionId}");

const inbound = (over = {}) => ({
  kind: "c2c",
  senderId: "owner-1",
  content: "你好",
  messageId: "m1",
  replyTarget: { scope: "c2c", targetId: "owner-1", msgId: "m1" },
  ...over,
});
const claimOf = (r) => (typeof r === "string" ? JSON.parse(r) : r);

// -- 2. 控制平面 /health（钩子探测路径） ----------------------------------
const health = await (await fetch(`http://127.0.0.1:${cp.port}/health`)).json();
assert.equal(health.ok, true);
assert.equal(health.running, true);
assert.equal(health.sessionId, "sess-A");
console.log("ok  GET /health 返回运行状态");

// -- 3. 白名单来信 → 收件箱 + 目标记忆 + state 持久化 ---------------------
await bot.emitMessage({}, inbound());
let st = gw.status();
assert.equal(st.inboxCount, 1, "白名单来信应入收件箱");
assert.equal(st.target, "c2c:owner-1");
const stateSaved = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
assert.equal(stateSaved.targetId, "owner-1");
assert.equal(stateSaved.msgId, "m1");
console.log("ok  来信入收件箱，目标持久化到 state.json");

// -- 4. 非白名单忽略 ------------------------------------------------------
await bot.emitMessage({}, inbound({ senderId: "stranger", messageId: "m2" }));
assert.equal(gw.status().inboxCount, 1, "陌生人不得入收件箱");
console.log("ok  非白名单来信被忽略");

// -- 5. messageId 去重 ----------------------------------------------------
await bot.emitMessage({}, inbound());
assert.equal(gw.status().inboxCount, 1, "重复 messageId 必须去重");
console.log("ok  重复 messageId 去重");

// -- 6. claim 四象限 ------------------------------------------------------
// Q1 注入：收件箱非空 → inject
let r = claimOf(gw.claim({ sessionId: "sess-A" }));
assert.equal(r.action, "inject");
assert.equal(r.count, 1);
assert.match(r.reason, /\[QQ\] 你好（来自 owner-1，/);
assert.equal(gw.status().inboxCount, 0, "claim 后收件箱清空");
console.log("ok  claim 注入：reason 带 [QQ] 标记与来源");

// Q2 自愈：注入后未见 qq_reply → self-heal（至多一次）
r = claimOf(gw.claim({ sessionId: "sess-A" }));
assert.equal(r.action, "self-heal");
assert.match(r.reason, /qq_reply/);
r = claimOf(gw.claim({ sessionId: "sess-A" }));
assert.equal(r.action, "none", "同一刺激至多自愈一次");
console.log("ok  claim 自愈：注入未回复触发提醒，且每刺激仅一次");

// Q3 两者：注入未回复 + 收件箱又来新消息 → 决策矩阵第 1 行优先（自愈），下一次才注入
await bot.emitMessage({}, inbound({ content: "第二条", messageId: "m3" }));
r = claimOf(gw.claim({ sessionId: "sess-A" }));
assert.equal(r.action, "inject");
assert.match(r.reason, /第二条/);
await bot.emitMessage({}, inbound({ content: "第三条", messageId: "m3b" }));
r = claimOf(gw.claim({ sessionId: "sess-A" }));
assert.equal(r.action, "self-heal", "矩阵顺序：自愈优先于新消息注入");
r = claimOf(gw.claim({ sessionId: "sess-A" }));
assert.equal(r.action, "inject");
assert.match(r.reason, /第三条/);
console.log("ok  claim 两者：自愈优先，随后注入新消息");

// Q4 无：履行回复义务后 → none
let rep = await gw.reply("收到");
assert.equal(rep.ok, true);
r = claimOf(gw.claim({ sessionId: "sess-A" }));
assert.equal(r.action, "none");
console.log("ok  claim 无刺激：none");

// 会话不匹配的 claim 一律 none
assert.equal(gw.claim({ sessionId: "sess-ZZZ" }).action, "none");
console.log("ok  非持锁会话 claim 返回 none");

// -- 7. qq_reply：履行回复义务 → 不再自愈 ---------------------------------
rep = await gw.reply("回复内容");
assert.equal(rep.ok, true);
assert.equal(rep.stats.sent, 1);
assert.equal(rep.stats.passive, 1, "有 msgId 时走被动回复");
assert.match(String(bot.sent.at(-1).content), /回复内容/);
console.log("ok  qq_reply 被动发送并返回余量");

// 注入后立即 reply → claim none（自愈条件被 lastReplyAt 取消）
await bot.emitMessage({}, inbound({ content: "m4 内容", messageId: "m4" }));
assert.equal(claimOf(gw.claim({ sessionId: "sess-A" })).action, "inject");
rep = await gw.reply("好的");
r = claimOf(gw.claim({ sessionId: "sess-A" }));
assert.equal(r.action, "none", "已回复的注入不再自愈");
console.log("ok  qq_reply 取消自愈条件");

// -- 8. 终端回合：清除刺激 + 镜像（🖥 终端 前缀，被动优先） ---------------
await bot.emitMessage(
  {},
  inbound({ content: "m5 内容", messageId: "m5", replyTarget: { scope: "c2c", targetId: "owner-1", msgId: "m5" } }),
);
assert.equal(claimOf(gw.claim({ sessionId: "sess-A" })).action, "inject");
let mir = await gw.mirror({ sessionId: "sess-A", text: "终端输入" });
assert.equal(mir.mirrored, true);
assert.equal(bot.sent.at(-1).content, "🖥 终端\n终端输入");
assert.equal(bot.sent.at(-1).target.msgId, "m5", "镜像走被动回复");
assert.equal(claimOf(gw.claim({ sessionId: "sess-A" })).action, "none", "终端回合清除自愈条件");
console.log("ok  终端镜像：🖥 终端 前缀 + 清除自愈");

// 镜像守卫：斜杠命令不镜像；会话不匹配整体拒绝；开关关闭不镜像
mir = await gw.mirror({ sessionId: "sess-A", text: "/secret-command" });
assert.equal(mir.mirrored, false);
assert.equal(mir.reason, "slash-command");
mir = await gw.mirror({ sessionId: "sess-B", text: "别的会话" });
assert.equal(mir.ok, false);
assert.equal(mir.reason, "session-mismatch");
await gw.applyConfig({ forwardTerminal: false });
mir = await gw.mirror({ sessionId: "sess-A", text: "关了镜像" });
assert.equal(mir.mirrored, false);
assert.equal(mir.reason, "mirror-off");
await gw.applyConfig({ forwardTerminal: true });
console.log("ok  镜像守卫：斜杠/跨会话/开关");

// -- 9. 分片 + 被动配额 4 条降级主动 --------------------------------------
await bot.emitMessage(
  {},
  inbound({ content: "长文", messageId: "m6", replyTarget: { scope: "c2c", targetId: "owner-1", msgId: "m6" } }),
);
const mark = bot.sent.length;
gw.pendingReplies = []; // 白盒清队：本节只测配额降级，与 FIFO 路由解耦（0.4.5 起缺省回复最早未回复者）
rep = await gw.reply("z".repeat(2200));
assert.equal(rep.ok, true);
assert.ok(rep.stats.sent >= 5, `2200 字 / 500 分片应 >=5 片，实际 ${rep.stats.sent}`);
assert.equal(rep.stats.passive, 4, "恰好 4 条被动");
assert.ok(rep.stats.proactive >= 1, "超额必须降级主动");
assert.equal(rep.warn, "exhausted", "余量应报耗尽");
console.log(`ok  配额降级：${rep.stats.passive} 被动 + ${rep.stats.proactive} 主动`);

// -- 10. 绑定态：待确认不入收件箱，双确认写白名单 -------------------------
assert.equal((await gw.bindStart()).ok, true);
const inboxBefore = gw.status().inboxCount;
await bot.emitMessage(
  {},
  {
    kind: "c2c",
    senderId: "NEW-OWNER",
    content: "bind me",
    messageId: "b1",
    replyTarget: { scope: "c2c", targetId: "NEW-OWNER", msgId: "b1" },
  },
);
assert.equal(gw.status().inboxCount, inboxBefore, "绑定态来信不入收件箱");
let bp = await gw.bindPending(2);
assert.equal(bp.ok, true);
assert.equal(bp.openid, "NEW-OWNER");
assert.notEqual((await gw.bindConfirm("WRONG")).ok, true, "openid 不一致必须拒绝");
const bc = await gw.bindConfirm("NEW-OWNER");
assert.equal(bc.ok, true);
const savedCfg = JSON.parse(readFileSync(configFile, "utf8"));
assert.deepEqual(savedCfg.allowFrom, ["NEW-OWNER"], "白名单应持久化");
assert.equal(gw.status().target, "c2c:NEW-OWNER", "绑定后记住回复目标");
await bot.emitMessage({}, inbound({ senderId: "NEW-OWNER", content: "新主人", messageId: "m7" }));
assert.equal(gw.status().inboxCount, inboxBefore + 1, "新白名单来信应入收件箱");
await bot.emitMessage({}, inbound({ senderId: "owner-1", content: "旧主人", messageId: "m8" }));
assert.equal(gw.status().inboxCount, inboxBefore + 1, "旧白名单应失效");
console.log("ok  绑定：待确认隔离 + 双确认 + 白名单替换");

// -- 11. 锁互斥：默认连接拒绝；takeover 请持锁方让位接管（0.3.1） ------------
const gw2 = new Gateway({ sessionId: "sess-B", pid: 200, isAlive: () => true, notify: () => {} });
const instancesBefore = globalThis.__qqBotFake.instances.length;
const refused = await gw2.connect();
assert.equal(refused.ok, false, "活锁必须拒绝第二个网关（autoConnect 语义：不抢）");
assert.match(refused.error, /PID 100/);
assert.equal(globalThis.__qqBotFake.instances.length, instancesBefore, "被拒时不得构造 bot");

// takeover：经持锁方控制平面 /health 探活 → POST /shutdown 让位 → 重试抢锁
const took = await gw2.connect({ takeover: true });
assert.equal(took.ok, true, "takeover 应请持锁方让位并接管");
assert.equal(took.takeover, true, "接管成功应带 takeover 标记");
assert.equal(gatewayIs(gw, "running"), false, "原持锁网关应已被请下线");
const bot2 = globalThis.__qqBotFake.instances.at(-1);
assert.ok(bot2?.started, "接管方应已启动传输");
bot2.emitReady();
assert.equal(gatewayIs(gw2, "running"), true);
const lock2 = JSON.parse(readFileSync(join(home, "lock.json"), "utf8"));
assert.equal(lock2.pid, 200);
gw2.disconnect();
console.log("ok  锁互斥：默认拒绝 + takeover 让位接管");

// -- 11b. 控制平面 /shutdown 端点（接管路径依赖）----------------------------
const sd = await fetch(`http://127.0.0.1:${cp.port}/shutdown`, { method: "POST" });
assert.equal(sd.status, 200);
assert.equal((await sd.json()).ok, true, "/shutdown 应立即回 200（先回包再让位）");
console.log("ok  控制平面 /shutdown：响应契约");

// -- 12. 控制平面 HTTP：claim / terminal-mirror / 容错 ---------------------
const httpResp = await (
  await fetch(`http://127.0.0.1:${cp.port}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "sess-A" }),
  })
).json();
assert.equal(httpResp.action, "none");
const mirResp = await (
  await fetch(`http://127.0.0.1:${cp.port}/terminal-mirror`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "sess-A", text: "http 终端" }),
  })
).json();
assert.equal(mirResp.ok, true);
const badJson = await fetch(`http://127.0.0.1:${cp.port}/claim`, { method: "POST", body: "not-json" });
assert.equal(badJson.status, 400);
const notFound = await fetch(`http://127.0.0.1:${cp.port}/nope`);
assert.equal(notFound.status, 404);
const wrongMethod = await fetch(`http://127.0.0.1:${cp.port}/claim`);
assert.equal(wrongMethod.status, 404, "GET /claim 不存在（只支持 POST）");
console.log("ok  控制平面 HTTP：claim/mirror/容错");

// -- 13. 空闲通知：消息无人取 → 桌面气泡 + QQ 回执（0.3.2） -------------------
const toasts = [];
const gw3 = new Gateway({
  sessionId: "sess-C",
  pid: 300,
  isAlive: () => true,
  idleNotifyDelayMs: 250,
  notify: (t, b) => toasts.push(`${t}|${b}`),
});
const t3 = await gw3.connect();
assert.equal(t3.ok, true, "gw3 应能连上（锁空闲）");
const bot3 = globalThis.__qqBotFake.instances.at(-1);
bot3.emitReady();
await bot3.emitMessage(
  {},
  {
    kind: "c2c",
    senderId: "NEW-OWNER", // 第 10 节绑定后白名单已换人
    content: "空闲提醒测试",
    messageId: "m9",
    replyTarget: { scope: "c2c", targetId: "NEW-OWNER", msgId: "m9" },
  },
);
await new Promise((r) => setTimeout(r, 900));
assert.equal(toasts.length, 1, "应弹一次桌面通知");
assert.match(toasts[0], /空闲提醒测试/, "通知应带消息预览");
const ack = bot3.sent.at(-1);
assert.match(ack.content, /已收到/, "QQ 侧应有回执");
assert.equal(ack.target.msgId, "m9", "回执走被动回复");
const r3 = gw3.claim({ sessionId: "sess-C" });
assert.equal(r3.action, "inject", "回执不消耗收件箱，消息仍可取");
assert.match(r3.reason, /空闲提醒测试/);
gw3.disconnect();
console.log("ok  空闲通知：桌面气泡 + QQ 回执 + 消息保留可取");

// -- 14. 值守循环（v2 /qq-watch）：qq_wait 全语义 ---------------------------
const gw4 = new Gateway({ sessionId: "sess-D", pid: 400, isAlive: () => true, notify: () => {} });
const t4 = await gw4.connect();
assert.equal(t4.ok, true, "gw4 应能连上（锁空闲）");
const bot4 = globalThis.__qqBotFake.instances.at(-1);
bot4.emitReady();

// a) 空收件箱 → 到点返回"继续值守"，duty 置位且 Stop 兜底接管
const timeoutText = await gw4.waitForInbound(1);
assert.match(timeoutText, /到点.*再次调用 qq_wait/, "空箱到点应提示继续值守");
assert.equal(gw4.status().duty, true, "首次 qq_wait 应置位 duty");
const dutyClaim = gw4.claim({ sessionId: "sess-D" });
assert.equal(dutyClaim.action, "self-heal", "值守断线时 Stop 兜底复用 self-heal 形态");
assert.match(dutyClaim.reason, /值守循环中断/);

// b) 等待中来信 → 唤醒返回内容；收件箱被取走；并发等待者计数正确
const waitP = gw4.waitForInbound(10);
assert.equal(gw4.status().dutyWaiters, 1, "等待中 dutyWaiters=1");
await new Promise((r) => setTimeout(r, 300));
await bot4.emitMessage({}, inbound({ senderId: "NEW-OWNER", content: "值守唤醒测试", messageId: "m14", replyTarget: { scope: "c2c", targetId: "NEW-OWNER", msgId: "m14" } }));
const wakeText = await waitP;
assert.match(wakeText, /\[QQ\] 值守唤醒测试/, "等待者应拿到来信内容");
assert.match(wakeText, /qq_wait/, "返回文本应带循环指引");
assert.equal(gw4.status().inboxCount, 0, "来信应被等待者取走");
assert.equal(gw4.status().dutyWaiters, 0, "结束后 dutyWaiters 归零");

// c) 取消保护：来信与取消同拍到达时，取消优先于取信——收件箱不动，消息留给后续 claim
let cancelled = false;
const cancelP = gw4.waitForInbound(10, () => cancelled);
await new Promise((r) => setTimeout(r, 300));
await bot4.emitMessage({}, inbound({ senderId: "NEW-OWNER", content: "取消时的信", messageId: "m15", replyTarget: { scope: "c2c", targetId: "NEW-OWNER", msgId: "m15" } }));
cancelled = true; // 下一拍轮询时会同时看到"有信"与"已取消"
const cancelText = await cancelP;
assert.match(cancelText, /被取消/, "取消应立即返回收尾文本");
assert.equal(gw4.status().inboxCount, 1, "取消不得动收件箱");
// 矩阵顺序：唤醒测试取走的信尚未回复 → 第一次 claim 是自愈提醒，随后才是注入
const healFirst = gw4.claim({ sessionId: "sess-D" });
assert.equal(healFirst.action, "self-heal", "未回复的唤醒来信先触发自愈");
const afterCancel = gw4.claim({ sessionId: "sess-D" });
assert.equal(afterCancel.action, "inject", "取消留下的信仍可被 claim 取走");
assert.match(afterCancel.reason, /取消时的信/);

// d) 显式退出值守：duty 复位，Stop 不再兜底（先回复履行上一注入的义务，避免自愈抢先）
const r4reply = await gw4.reply("值守测试回复");
assert.equal(r4reply.ok, true);
gw4.stopDuty();
assert.equal(gw4.status().duty, false, "qq_watch_stop 应复位 duty");
assert.equal(gw4.claim({ sessionId: "sess-D" }).action, "none", "退出后 Stop 兜底不触发");
gw4.disconnect();

// e) 未连接时 qq_wait 直接报错并引导
const gw5 = new Gateway({ sessionId: "sess-E", pid: 500, isAlive: () => true, notify: () => {} });
const noConn = await gw5.waitForInbound(2);
assert.match(noConn, /未连接/, "未连接应返回引导文本");
console.log("ok  值守循环：到点续等/等待唤醒/取消保护/Stop 兜底/显式退出/未连接引导");

// -- 15. 残留锁自动回收（0.4.1 真机坑）：PID 复用 + 端口死 → 拆锁接管 -------
// 场景回放：整退 zcode 硬杀网关 → lock.json 残留 → PID 被 Edge 复用 → isAlive 误判
const deadPort = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
});
await new Promise((r) => setTimeout(r, 100));
writeFileSync(join(home, "lock.json"), JSON.stringify({ pid: 424242, host: hostname(), port: deadPort, cwd: "X:\gone", at: 12345 }));
const gw6 = new Gateway({ sessionId: "sess-F", pid: 600, isAlive: () => true, notify: () => {} });
const t6 = await gw6.connect({ takeover: true });
assert.equal(t6.ok, true, "残留锁（PID 假活 + 端口死）应被自动拆除并接管");
const lock6 = JSON.parse(readFileSync(join(home, "lock.json"), "utf8"));
assert.equal(lock6.pid, 600, "拆锁后应写入新持有者");
gw6.disconnect();

// 对照：端口活着但不是本插件网关（health 不匹配）→ 保守拒绝，不动锁
const alienServer = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
const alienPort = await new Promise((resolve) => alienServer.listen(0, "127.0.0.1", () => resolve(alienServer.address().port)));
writeFileSync(join(home, "lock.json"), JSON.stringify({ pid: 424243, host: hostname(), port: alienPort, at: 12345 }));
const gw7 = new Gateway({ sessionId: "sess-G", pid: 700, isAlive: () => true, notify: () => {} });
const t7 = await gw7.connect({ takeover: true });
assert.equal(t7.ok, false, "端口活着但非本插件网关时必须拒绝接管");
assert.match(t7.error, /PID 424243/, "报错应指明持锁者");
const lockAfter = JSON.parse(readFileSync(join(home, "lock.json"), "utf8"));
assert.equal(lockAfter.pid, 424243, "拒绝时锁文件不得被改动");
alienServer.close();
console.log("ok  残留锁回收：死端口自动拆锁 + 陌生服务保守拒绝");

// -- 16. 入站媒体（0.4.2 真机发现 #2）：表情标签解码 + 图片附件下载 + rawEvent --
// 真机：商城表情 content 是 <faceType=6,...ext> 空壳标签；GIF/图片 content 为空、媒体在 attachments.url
const gifBytes = Buffer.from("4749463839610a", "hex"); // GIF 魔数
const gifServer = http.createServer((req, res) => {
  res.setHeader("content-type", "image/gif");
  res.end(gifBytes);
});
const gifPort = await new Promise((resolve) => gifServer.listen(0, "127.0.0.1", () => resolve(gifServer.address().port)));
const mediaHome = mkdtempSync(join(tmpdir(), "qqbot-mediaflow-"));
process.env.ZCODE_QQBOT_MEDIA = join(mediaHome, "media");
const gw8 = new Gateway({ sessionId: "sess-H", pid: 800, notify: () => {} });
await gw8.init();
const bot8 = globalThis.__qqBotFake.instances.at(-1);
bot8.emitReady();
const waitInbox = async (gw, n) => {
  for (let i = 0; i < 50; i++) {
    if ((gw.status().inboxPreview ?? []).length >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("消息应在下载完成后入箱（含媒体行）");
};
// §10 绑定测试把白名单换成了 NEW-OWNER——沿用该身份
const mediaMsg = (over = {}) =>
  inbound({ senderId: "NEW-OWNER", replyTarget: { scope: "c2c", targetId: "NEW-OWNER", msgId: over.messageId ?? "m1" }, ...over });

// a) 商城大表情：标签解码为可读描述
await bot8.emitMessage({}, mediaMsg({ content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">', messageId: "st-1" }));
await waitInbox(gw8, 1);
let c = claimOf(gw8.claim({ via: "ups" }));
assert.equal(c.action, "inject");
assert.match(c.reason, /大表情 faceType=6 faceId=0/, "商城表情应解码为可读描述");
await gw8.reply("收到表情"); // 履行回复义务，下一轮才允许直接取信

// b) GIF 附件：content 为空也能入箱，且下载到媒体目录、路径写进注入文本
await bot8.emitMessage({}, mediaMsg({
  content: "",
  messageId: "gif-1",
  attachments: [{ content_type: "image/gif", url: `http://127.0.0.1:${gifPort}/s.gif`, filename: "s.gif", width: 240, height: 240, size: gifBytes.length }],
}));
await waitInbox(gw8, 1);
c = claimOf(gw8.claim({ via: "ups" }));
assert.match(c.reason, /图片已存/, "附件消息应包含下载结果行");
const savedPath = c.reason.match(/\[图片已存 (.+?)（image\/gif/)?.[1];
assert.ok(savedPath, "注入文本应带本地路径");
assert.ok(savedPath.startsWith(join(mediaHome, "media")), "应落在媒体目录");
assert.deepEqual(readFileSync(savedPath), gifBytes, "落盘内容应与源文件一致");
await gw8.reply("看到图了");

// c) 无 url 的图片附件：不下载，文字描述兜底（不丢消息）
await bot8.emitMessage({}, mediaMsg({
  content: "看这个",
  messageId: "att-2",
  attachments: [{ content_type: "image/png", filename: "x.png", width: 100, height: 80 }],
}));
await waitInbox(gw8, 1);
c = claimOf(gw8.claim({ via: "ups" }));
assert.match(c.reason, /看这个[\s\S]*收到附件 x\.png（image\/png 100×80）/, "无 url 附件应文字描述");
await gw8.reply("好的");

// d) 未映射网关事件：rawEvent 落日志留证据（GIF 消失案的调查通道）
bot8.emitRawEvent({ eventType: "SOME_NEW_EVENT", data: { hello: 1 } });
await new Promise((r) => setTimeout(r, 100));
assert.match(readFileSync(join(home, "log.jsonl"), "utf8"), /"event":"raw-event"/, "未映射事件应记 raw-event 日志");

// e) 空消息（无文本无附件）仍不入箱
await bot8.emitMessage({}, mediaMsg({ content: "   ", messageId: "empty-1" }));
await new Promise((r) => setTimeout(r, 150));
c = claimOf(gw8.claim({ via: "ups" }));
assert.equal(c.action, "none", "纯空消息不应入箱");
gw8.disconnect();
gifServer.close();
delete process.env.ZCODE_QQBOT_MEDIA;
console.log("ok  入站媒体：大表情解码 / GIF 下载落盘 / 无url兜底 / rawEvent 留证 / 空消息丢弃");

// -- 17. 群开放名单（0.4.3）：开放群全员 @ 放行；陌生群仍逐人过滤 --------------
const gw9 = new Gateway({ sessionId: "sess-I", pid: 900, notify: () => {} });
await gw9.init();
await gw9.applyConfig({ allowGroup: true, allowGroupFrom: ["grp-open"] });
const bot9 = globalThis.__qqBotFake.instances.at(-1);
bot9.emitReady();
const groupMsg = (senderId, groupId, messageId) => ({
  kind: "group",
  senderId,
  content: `群消息${messageId}`,
  messageId,
  replyTarget: { scope: "group", targetId: groupId, msgId: messageId },
});

// a) 开放群里的陌生成员 → 放行（水群模式）
await bot9.emitMessage({}, groupMsg("member-x", "grp-open", "g17a"));
await waitInbox(gw9, 1);
let c17 = claimOf(gw9.claim({ via: "ups" }));
assert.equal(c17.action, "inject");
assert.match(c17.reason, /群消息g17a/, "开放群陌生成员应入箱");
await gw9.reply("群开放收到");

// b) 陌生群里的陌生成员 → 拒（not-allowlisted，防陌生群拉 bot 驱动会话）
await bot9.emitMessage({}, groupMsg("member-y", "grp-other", "g17b"));
await new Promise((r) => setTimeout(r, 150));
assert.equal((gw9.status().inboxPreview ?? []).length, 0, "陌生群陌生成员不得入箱");
c17 = claimOf(gw9.claim({ via: "ups" }));
assert.equal(c17.action, "none");

// c) 陌生群里的白名单成员（owner 回退路径）→ 保留放行
await bot9.emitMessage({}, groupMsg("NEW-OWNER", "grp-other", "g17c"));
await waitInbox(gw9, 1);
c17 = claimOf(gw9.claim({ via: "ups" }));
assert.equal(c17.action, "inject", "owner 在任何群都应放行");
await gw9.reply("owner 回退");
assert.deepEqual(gw9.status().allowGroupFrom, ["grp-open"], "状态面应暴露群开放名单");
gw9.disconnect();
console.log("ok  群开放名单：开放群全员放行 / 陌生群拒陌生成员 / owner 回退保留");

// -- 18. 按人路由 + 被动失败降级（0.4.4：多人群聊互踩 / 撤回后回复蒸发）-------
const gw10 = new Gateway({ sessionId: "sess-J", pid: 1000, notify: () => {} });
await gw10.init();
await gw10.applyConfig({ allowGroup: true, allowGroupFrom: ["grp-x"] });
const bot10 = globalThis.__qqBotFake.instances.at(-1);
bot10.emitReady();

// a) 两人先后 @（同批取走）：注入带"按人分别回复"提示；qq_reply(to) 路由到该人最新来信
await bot10.emitMessage({}, groupMsg("NEW-OWNER", "grp-x", "m18a"));
await bot10.emitMessage({}, groupMsg("member-b", "grp-x", "m18b"));
await waitInbox(gw10, 2);
let c18 = claimOf(gw10.claim({ via: "ups" }));
assert.equal(c18.action, "inject");
assert.equal(c18.count, 2, "两人来信应同批注入");
assert.match(c18.reason, /分别调用 qq_reply/, "多发件人注入应带按人回复提示");
assert.match(c18.reason, /member-b/);
await gw10.reply("回给 A", "NEW-OWNER");
assert.equal(bot10.sent.at(-1).target.msgId, "m18a", "to=A 应路由到 A 的来信 msg_id");
await gw10.reply("回给 B（默认最近来信人）");
assert.equal(bot10.sent.at(-1).target.msgId, "m18b", "默认应路由到最近来信人 B");

// b) to 指向没有记录的人 → 明确报错而不是发错对象
const rBad = await gw10.reply("不该发出", "stranger-x");
assert.equal(rBad.ok, false);
assert.match(rBad.error, /stranger-x/);
assert.equal(bot10.sent.length, 2, "报错路径不得产生出站");

// c) 被动发送失败（msg_id 被撤回/超窗）→ 降级主动重发，回复不蒸发
bot10.failPassive = true;
const rFall = await gw10.reply("降级测试");
assert.equal(rFall.ok, true);
assert.equal(rFall.stats.proactive, 1, "被动失败应降级为 1 片主动");
assert.equal(bot10.sent.at(-1).target.msgId, undefined, "降级片不得携带 msg_id");
bot10.failPassive = false;

// d) 群被动窗口 5 分钟：过期目标自动去掉 msg_id 走主动
const stale = gw10.recentTargets.get("member-b");
stale.at -= 6 * 60 * 1000;
await gw10.reply("过期窗口测试", "member-b");
assert.equal(bot10.sent.at(-1).target.msgId, undefined, "群 5 分钟窗口外的 msg_id 不得使用");
gw10.disconnect();
console.log("ok  按人路由：to=A/B 各归其位 / 陌生人拒绝 / 被动失败降级 / 群 5min 窗口");

// -- 19. 顺序到达不互踩（0.4.5 真机案：A 已注入处理中，B 后到不得抢走路由）--
const gw11 = new Gateway({ sessionId: "sess-K", pid: 1100, notify: () => {} });
await gw11.init();
await gw11.applyConfig({ allowGroup: true, allowGroupFrom: ["grp-x"] });
const bot11 = globalThis.__qqBotFake.instances.at(-1);
bot11.emitReady();

// a) A 注入后 B 才到：对 A 的回复（不带 to）必须回到 A——旧逻辑会被 B 覆盖
await bot11.emitMessage({}, groupMsg("NEW-OWNER", "grp-x", "m19a"));
await waitInbox(gw11, 1);
let c19 = claimOf(gw11.claim({ via: "ups" }));
assert.equal(c19.action, "inject");
await bot11.emitMessage({}, groupMsg("member-b", "grp-x", "m19b")); // B 后到，模型正忙于 A
await gw11.reply("答 A（不带 to）");
assert.equal(bot11.sent.at(-1).target.msgId, "m19a", "对 A 的回复不得被后到的 B 抢走");

// b) B 随后注入，正常回到 B
await waitInbox(gw11, 1);
c19 = claimOf(gw11.claim({ via: "ups" }));
assert.equal(c19.action, "inject");
await gw11.reply("答 B");
assert.equal(bot11.sent.at(-1).target.msgId, "m19b");

// c) 队列清空后缺省回最近目标（原 0.4.4 语义作兜底）
await gw11.reply("追加一句");
assert.equal(bot11.sent.at(-1).target.msgId, "m19b", "队列空时回最近来信人");
gw11.disconnect();
console.log("ok  顺序到达：FIFO 路由不被后到者抢占 / 队列空回最近");

// -- 清理 ------------------------------------------------------------------
await cp.close();
console.log("\nFLOW HARNESS PASSED");

function gatewayIs(g, key) {
  return Boolean(g.status()[key]);
}
