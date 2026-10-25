/**
 * 网关（M3）：QQ WS 传输 + 桥接状态机，内嵌在 MCP 服务器进程里，会话期存活。
 *
 * 移植基线是 v0 的桥接原型：传输/鉴权/去重/配额逻辑保留，两处结构性重排：
 * 1. 注入通道：zcode 没有向会话注入用户消息的 API——来信进收件箱，
 *    Stop 钩子经控制平面 /claim 取走（ADR-0002，决策矩阵见 claim()）。
 * 2. 出站触发：zcode 无 assistant 消息事件可挂——模型调 qq_reply
 *    工具出站（本文件 reply()），忘调时 Stop 自愈兜底（每刺激至多 1 次）。
 *
 * QQ WS 懒建立：只有 connect()/autoConnect 才连。SDK 加载 seam：环境变量
 * ZCODE_QQBOT_SDK 指向替代模块（fake-sdk harness 用），缺省真包。
 */

import {
  GROUP_PASSIVE_TTL_MS,
  PASSIVE_REPLY_LIMIT,
  PASSIVE_REPLY_TTL_MS,
  ReplyBudget,
  budgetWarning,
  chunkText,
  type BudgetWarning,
} from "./core.ts";
import {
  configPath,
  ensureExampleConfig,
  loadConfig,
  migrateConfig,
  saveAllowFrom,
  saveConfig,
  type QQBotConfig,
} from "./config.ts";
import { acquireLock, breakStaleLock, readLock, releaseLock, type LockInfo } from "./lock.ts";
import {
  collectAttachments,
  decodeFaceTags,
  describeAttachment,
  downloadAttachment,
  mediaDir,
  type MediaAttachment,
} from "./media.ts";
import net from "node:net";
import os from "node:os";
import { freshMsgId, loadState, saveState, type PersistedTarget, type Scope } from "./state.ts";
import { logLine } from "./log.ts";
import { spawn } from "node:child_process";

/** 每回合 Stop 注入上限（M0 实测：每用户回合链至多 3 次续跑）。 */
export const CLAIM_MAX_PER_TURN = 3;
/** 收件箱容量上限，超出丢最旧（防长期不 claim 撑爆内存）。 */
const INBOX_MAX = 50;
/** messageId 去重窗口（长连接断线重连期可能重投，窗口取实测安全值）。 */
const SEEN_MAX = 500;
/** 自愈提醒文案（design.md §4 决策矩阵第 1 行）。 */
export const SELF_HEAL_REASON = "[QQ 桥] 请调用 qq_reply 工具，把上面的回复发给 QQ";
/** 值守续跑文案（v2 值守循环：回合意外结束而值守仍开启时，Stop/UPS 把模型拉回 qq_wait）。 */
export const DUTY_CONTINUE_REASON =
  "[QQ 桥] 值守循环中断了：请立即调用 qq_wait 工具继续等待 QQ 来信（值守期间这是固定职责；若上面有未处理/未回复的来信，先处理再等待）";
/** qq_wait 单次等待的平台上限（zcode 工具超时 _meta.timeoutMs 上限 30 分钟，V0 实测）。 */
export const WAIT_MAX_SEC = 1800;
/** 值守轮询粒度：检查收件箱/取消/断线的节拍。 */
const WAIT_TICK_MS = 1000;
/** 终端镜像前缀（用户锁定决策：QQ 侧持续可见来源）。 */
export const TERMINAL_PREFIX = "🖥 终端";

export interface InboxItem {
  openid: string;
  content: string;
  at: number;
  scope: Scope;
  targetId: string;
  msgId?: string;
}

export type ClaimResult =
  | { action: "none" }
  | { action: "self-heal"; reason: string }
  | { action: "inject"; reason: string; count: number };

export interface SendStats {
  sent: number;
  passive: number;
  proactive: number;
}

export type ReplyOutcome =
  | { ok: true; stats: SendStats; remaining: number; warn: BudgetWarning }
  | { ok: false; error: string };

export interface PendingBind {
  openid: string;
  scope: Scope;
  targetId: string;
  msgId?: string;
  at: number;
}

export interface GatewayOptions {
  sessionId?: string;
  /** 锁 pid 覆盖（测试用，缺省 process.pid）。 */
  pid?: number;
  /** 锁存活探测覆盖（测试用）。 */
  isAlive?: (pid: number) => boolean;
  /** 空闲通知延迟（测试用，缺省 8s）。 */
  idleNotifyDelayMs?: number;
  /** 桌面通知实现（测试注入；缺省 Windows 气泡，非 Windows 空操作）。 */
  notify?: (title: string, body: string) => void;
}

/** PowerShell 单引号字面量转义。 */
function psStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Windows 气泡/Toast 通知（无第三方依赖；失败静默）。 */
function windowsBalloon(title: string, body: string): void {
  if (process.platform !== "win32") return;
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$n = New-Object System.Windows.Forms.NotifyIcon;",
    "$n.Icon = [System.Drawing.SystemIcons]::Information;",
    "$n.Visible = $true;",
    `$n.ShowBalloonTip(6000, ${psStr(title)}, ${psStr(body)}, [System.Windows.Forms.ToolTipIcon]::Info);`,
    "Start-Sleep -Seconds 7;",
    "$n.Dispose();",
  ].join("\n");
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // 通知是尽力而为
  }
}

/** 从 env 探测 zcode 会话 id；模板展开失败会留下 "${...}" 字面量，过滤之。 */
function detectSessionId(explicit?: string): string | undefined {
  const candidates = [explicit, process.env.ZCODE_QQBOT_SESSION_ID, process.env.CLAUDE_SESSION_ID, process.env.ZCODE_SESSION_ID];
  for (const c of candidates) {
    if (c && !c.startsWith("${")) return c;
  }
  return undefined;
}

export class Gateway {
  readonly sessionId: string | undefined;
  private readonly lockPid: number | undefined;
  private readonly lockIsAlive: ((pid: number) => boolean) | undefined;

  private bot: any;
  private abort: AbortController | undefined;
  private connecting = false;
  running = false;
  ready = false;
  private cfg: QQBotConfig | undefined;
  private port: number | undefined;

  private target: PersistedTarget | undefined;
  private readonly budget = new ReplyBudget();
  private readonly seen = new Set<string>();
  private inbox: InboxItem[] = [];
  private outCount = 0;
  private lastError: string | undefined;

  private bindMode = false;
  private pendingBind: PendingBind | undefined;

  private readonly idleNotifyDelayMs: number;
  private readonly notify: (title: string, body: string) => void;
  /** claim 计数（含 none）：空闲通知靠它判断"入箱后有没有人来取过信"。 */
  private claimSeq = 0;
  private lastIdleNotifyAt = 0;
  private readonly idleTimers = new Set<ReturnType<typeof setTimeout>>();

  /** 最近一次刺激：QQ 消息注入或自愈提醒。用于 claim 决策矩阵。 */
  private lastStimulus: { kind: "inject" | "self-heal"; at: number } | undefined;
  /** 模型最近一次 qq_reply 时间（晚于 lastStimulus.at = 已履行回复义务）。 */
  private lastReplyAt = 0;

  /** v2 值守：首次 qq_wait 后置位；断开或 qq_watch_stop 复位。 */
  private duty = false;
  /** 当前挂起的 qq_wait 数量（status 可见；claim 兜底据此判断"值守是否断线"。 */
  private waiterCount = 0;
  /** 最近来信人 → 回复目标（0.4.4 按人路由）：qq_reply(to) 取这里，撤回重发后自动用最新 msg_id。 */
  private recentTargets = new Map<string, PersistedTarget>();
  /** 按注入顺序的待回复队列（0.4.5）：qq_reply 不带 to 时 FIFO 回应最早未回复者——后来消息不再抢走路由。 */
  private pendingReplies: Array<{ openid: string; target: PersistedTarget }> = [];

  constructor(opts: GatewayOptions = {}) {
    this.sessionId = detectSessionId(opts.sessionId);
    this.lockPid = opts.pid;
    this.lockIsAlive = opts.isAlive;
    this.idleNotifyDelayMs = opts.idleNotifyDelayMs ?? 8000;
    this.notify = opts.notify ?? windowsBalloon;
  }

  /** 控制平面端口（mcp-server 启动监听后回填；进锁文件供钩子寻址）。 */
  setPort(port: number): void {
    this.port = port;
  }

  /**
   * 进程启动引导：建样例配置、预载配置、按 autoConnect 决定是否自动连接。
   * QQ WS 懒建立——autoConnect=false 时待机直到 qq_connect。
   */
  async init(): Promise<void> {
    migrateConfig();
    ensureExampleConfig();
    const pre = loadConfig();
    if (pre.ok) {
      this.cfg = pre.config;
      // 恢复上次目标（msg_id 只在 TTL 内可被动回复）。
      const persisted = loadState();
      this.target = persisted
        ? { scope: persisted.scope, targetId: persisted.targetId, msgId: freshMsgId(persisted, Date.now()) }
        : undefined;
      if (pre.config.autoConnect) {
        await this.connect();
      } else {
        logLine("idle", { reason: "autoConnect=false，等待 qq_connect" });
      }
    } else {
      logLine("idle", { reason: pre.error, config: pre.path });
    }
  }

  private async loadSdk(): Promise<any> {
    const override = process.env.ZCODE_QQBOT_SDK;
    const mod: any = override ? await import(override) : await import("@tencent-connect/qqbot-nodejs");
    return mod?.QQBot ?? mod?.default?.QQBot;
  }

  /**
   * 连接 QQ 网关（抢锁）。已连接直接成功；失败返回错误与持锁者。
   * takeover（qq_connect 工具用）：锁被别的活网关持有时，先经其控制平面请它让位
   * （/health 探活 → POST /shutdown → 重试抢锁）。autoConnect 不接管——只有用户
   * 明确在哪个会话点连接，桥才跟到哪个会话。
   */
  async connect(opts: { takeover?: boolean } = {}): Promise<
    { ok: true; takeover?: boolean } | { ok: false; error: string; holder?: LockInfo }
  > {
    if (this.running) return { ok: true };
    if (this.connecting) return { ok: false, error: "正在连接中" };
    this.connecting = true;
    try {
      ensureExampleConfig();
      const loaded = loadConfig();
      if (!loaded.ok) {
        this.lastError = loaded.error;
        logLine("config-error", { error: loaded.error });
        return { ok: false, error: `${loaded.error}（配置模板在 ${loaded.path}，用 qq_setup 或 /qq-pair 填入凭据）` };
      }
      this.cfg = loaded.config;

      let lock = acquireLock({ pid: this.lockPid, port: this.port, sessionId: this.sessionId, cwd: process.cwd(), isAlive: this.lockIsAlive });
      let tookOver = false;
      if (!lock.ok && opts.takeover && lock.holder.port && lock.holder.host === os.hostname()) {
        const step = await this.askHolderToStepDown(lock.holder);
        if (step === "stepped" || step === "port-dead") {
          if (step === "port-dead") {
            // 残留锁（0.4.1 真机坑：整退 zcode 硬杀网关 → 锁残留 → PID 被
            // 复用骗过 isAlive → 接管探活又够不着死端口 → 死锁）。端口无监听
            // 即网关必死，拆锁重试。
            const broken = breakStaleLock(lock.holder.pid);
            logLine("stale-lock-cleared", { holder: lock.holder, broken });
          }
          await new Promise((r) => setTimeout(r, 400));
          const retry = acquireLock({ pid: this.lockPid, port: this.port, sessionId: this.sessionId, cwd: process.cwd(), isAlive: this.lockIsAlive });
          if (retry.ok) {
            logLine("takeover", { fromPid: lock.holder.pid, fromPort: lock.holder.port, mode: step });
            lock = retry;
            tookOver = true;
          }
        }
      }
      if (!lock.ok) {
        const h = lock.holder;
        const since = h.at ? new Date(h.at).toLocaleString("zh-CN", { hour12: false }) : "?";
        this.lastError = `QQ 连接已被 PID ${h.pid}（${h.host}）占用`;
        logLine("lock-busy", { holder: h });
        return {
          ok: false,
          error: `QQ 已由 PID ${h.pid} 的会话占用（自 ${since}${h.cwd ? `，目录 ${h.cwd}` : ""}）。在本会话再试一次 /qq-connect 会请它自动让位；若仍失败，去那个会话 /qq-disconnect 或直接关闭它`,
          holder: h,
        };
      }
      const finalTakeover = tookOver;

      let QQBot: any;
      try {
        QQBot = await this.loadSdk();
      } catch (err) {
        this.lastError = `加载 QQ SDK 失败：${(err as Error).message}`;
        logLine("sdk-error", { error: this.lastError });
        releaseLock({ pid: this.lockPid });
        return { ok: false, error: this.lastError };
      }

      try {
        this.bot = new QQBot({
          appId: this.cfg.appId,
          appSecret: this.cfg.appSecret,
          markdownSupport: this.cfg.markdownSupport,
          logger: {
            info: (m: string) => logLine("sdk", { msg: m }),
            error: (m: string) => logLine("sdk-error", { msg: m }),
            warn: (m: string) => logLine("sdk-warn", { msg: m }),
            debug: () => {},
          },
        });
      } catch (err) {
        this.lastError = `创建 QQBot 失败：${(err as Error).message}`;
        logLine("bot-error", { error: this.lastError });
        releaseLock({ pid: this.lockPid });
        return { ok: false, error: this.lastError };
      }

      this.bot.on("message", (ctx: unknown, msg: any) => void this.onQQMessage(ctx, msg));
      this.bot.on("ready", () => {
        this.ready = true;
        logLine("ready", { sessionId: this.sessionId });
      });
      this.bot.on("resumed", () => logLine("resumed"));
      this.bot.on("disconnected", (ev: unknown) => logLine("disconnected", { ev: String(ev) }));
      this.bot.on("error", (err: Error) => {
        this.lastError = err.message;
        logLine("ws-error", { error: err.message });
      });
      // 未映射的网关事件（表情/媒体若以新事件类型推送会落到这里——留证据用）
      this.bot.on("rawEvent", (ctx: any) => {
        try {
          const type = String(ctx?.eventType ?? "?");
          const preview = JSON.stringify(ctx?.data ?? {}).slice(0, 240);
          logLine("raw-event", { type, preview });
        } catch {
          // 证据日志尽力而为
        }
      });

      this.abort = new AbortController();
      this.running = true;
      this.ready = false;
      this.seen.clear();
      this.budget.reset();
      const connecting = `${this.cfg.allowFrom.length ? `已授权 ${this.cfg.allowFrom.length} 个用户` : "白名单为空：请先绑定（qq_bind_start）"}`;
      logLine("connecting", { detail: connecting });
      this.bot.start(this.abort.signal).catch((err: Error) => {
        this.running = false;
        this.ready = false;
        this.lastError = err.message;
        logLine("start-error", { error: err.message });
        releaseLock({ pid: this.lockPid });
      });
      return { ok: true, ...(finalTakeover ? { takeover: true } : {}) };
    } finally {
      this.connecting = false;
    }
  }

  /**
   * 请持锁网关让位（0.4.1 三态）：
   *   "stepped"    —— 对方确认让位，可以重试抢锁；
   *   "port-dead"  —— 持锁端口无监听（ECONNREFUSED）：网关必死（进程被硬杀后
   *                   PID 复用骗过 isAlive 的残留锁），可安全拆锁；
   *   "refused"    —— 端口有东西但不是我们的网关/不回话：保守放弃。
   * 探活校验 pid 与锁同源，防误伤陌生服务。
   */
  private async askHolderToStepDown(holder: LockInfo): Promise<"stepped" | "port-dead" | "refused"> {
    const base = `http://127.0.0.1:${holder.port}`;
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      const hj = (await health.json()) as { ok?: boolean; pid?: number };
      if (!health.ok || hj?.ok !== true || (typeof hj.pid === "number" && hj.pid !== holder.pid)) {
        logLine("takeover-refused", { holder, reason: "health-mismatch" });
        return "refused";
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.cause?.code === "ECONNREFUSED" && (await this.portRefused(holder.port!))) {
        logLine("takeover-port-dead", { holder });
        return "port-dead";
      }
      logLine("takeover-refused", { holder, reason: "health-unreachable" });
      return "refused";
    }
    try {
      const res = await fetch(`${base}/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) });
      if (!res.ok) {
        logLine("takeover-refused", { holder, reason: `shutdown-${res.status}` });
        return "refused";
      }
      return "stepped";
    } catch {
      logLine("takeover-refused", { holder, reason: "shutdown-unreachable" });
      return "refused";
    }
  }

  /** TCP 层确认端口无人监听（ECONNREFUSED 才算死；超时/其他错误保守视为活着）。 */
  private portRefused(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      const finish = (dead: boolean) => {
        socket.destroy();
        resolve(dead);
      };
      socket.setTimeout(800, () => finish(false));
      socket.on("connect", () => finish(false));
      socket.on("error", (err) => finish((err as NodeJS.ErrnoException).code === "ECONNREFUSED"));
    });
  }

  /** 等待 ready/error/超时，给 qq_connect 即时反馈用。 */
  waitReady(timeoutMs = 4000): Promise<"ready" | "error" | "timeout"> {
    if (this.ready) return Promise.resolve("ready");
    if (!this.running) return Promise.resolve("error");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.ready ? "ready" : this.lastError ? "error" : "timeout");
      }, timeoutMs);
      const onReady = () => done("ready");
      const onError = () => done("error");
      const done = (r: "ready" | "error") => {
        cleanup();
        resolve(r);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.bot?.off?.("ready", onReady);
        this.bot?.off?.("error", onError);
      };
      this.bot?.on?.("ready", onReady);
      this.bot?.on?.("error", onError);
    });
  }

  disconnect(reason = "manual"): void {
    try {
      this.abort?.abort();
      this.bot?.stop?.();
    } catch (err) {
      logLine("stop-error", { error: (err as Error).message });
    }
    this.bot = undefined;
    this.abort = undefined;
    this.running = false;
    this.ready = false;
    this.inbox = [];
    this.bindMode = false;
    this.pendingBind = undefined;
    this.lastStimulus = undefined;
    this.duty = false; // 断开即退出值守（挂起的 qq_wait 会经 running=false 自行返回）
    this.pendingReplies = []; // 排队回复随断开作废（重连后来信重新入队）
    for (const t of this.idleTimers) clearTimeout(t);
    this.idleTimers.clear();
    releaseLock({ pid: this.lockPid });
    logLine("stopped", { reason });
  }

  /** stdin 关闭（会话退出）或被其他会话接管（remote-takeover）时的收尾。 */
  shutdown(reason = "session-exit"): void {
    this.disconnect(reason);
  }

  // ------------------------------------------------------------------ inbound

  private async onQQMessage(_ctx: unknown, msg: any): Promise<void> {
    try {
      if (!msg || typeof msg !== "object") return;
      const kind = msg.kind as string;
      const senderId = String(msg.senderId ?? "");
      const text = decodeFaceTags(typeof msg.content === "string" ? msg.content : "").trim();
      const rt = msg.replyTarget;

      if (kind !== "c2c" && kind !== "group") return;
      if (kind === "group" && !this.cfg?.allowGroup) {
        logLine("inbound-ignored", { reason: "group-disabled", sender: senderId });
        return;
      }

      // 绑定态：下一条私聊进待确认，不入收件箱（双确认第一步）。
      if (this.bindMode) {
        if (kind === "c2c" && senderId && rt?.scope && rt?.targetId) {
          this.pendingBind = {
            openid: senderId,
            scope: rt.scope === "group" ? "group" : "c2c",
            targetId: rt.targetId,
            msgId: typeof rt.msgId === "string" ? rt.msgId : undefined,
            at: Date.now(),
          };
          this.bindMode = false;
          logLine("bind-pending", { openid: senderId });
        }
        return;
      }

      if (!this.cfg) return;
      // 0.4.3 群开放名单：名单内群的所有成员 @ 放行（水群模式）；其余照走逐人白名单。
      const groupOpen =
        kind === "group" &&
        typeof rt?.targetId === "string" &&
        (this.cfg.allowGroupFrom ?? []).includes(rt.targetId);
      if (!groupOpen) {
        if (this.cfg.allowFrom.length === 0) {
          logLine("inbound-ignored", { reason: "no-allowFrom", sender: senderId });
          return;
        }
        if (!this.cfg.allowFrom.includes(senderId)) {
          logLine("inbound-ignored", { reason: "not-allowlisted", sender: senderId });
          return;
        }
      }
      if (msg.messageId && this.seen.has(String(msg.messageId))) {
        logLine("inbound-dedupe", { messageId: String(msg.messageId) });
        return;
      }
      if (msg.messageId) {
        const id = String(msg.messageId);
        this.seen.add(id);
        if (this.seen.size > SEEN_MAX) {
          const first = this.seen.values().next().value;
          if (first !== undefined) this.seen.delete(first);
        }
      }

      if (!rt || !rt.scope || !rt.targetId) return;
      this.rememberTarget(rt.scope === "group" ? "group" : "c2c", rt.targetId, rt.msgId, senderId);

      const attachments = collectAttachments(msg);
      logLine("inbound", {
        kind,
        sender: senderId,
        preview: text.slice(0, 120),
        ...(attachments.length ? { attachments: attachments.length } : {}),
      });
      const mediaLines = await this.ingestMedia(attachments, String(msg.messageId ?? "msg"));
      const composed = [text, ...mediaLines].filter(Boolean).join("\n");
      if (!composed) return;

      this.inbox.push({
        openid: senderId,
        content: composed,
        at: Date.now(),
        scope: rt.scope === "group" ? "group" : "c2c",
        targetId: rt.targetId,
        msgId: typeof rt.msgId === "string" ? rt.msgId : undefined,
      });
      if (this.inbox.length > INBOX_MAX) {
        this.inbox.shift();
        logLine("inbox-overflow", { cap: INBOX_MAX });
      }
      this.scheduleIdleNotify(composed);
    } catch (err) {
      logLine("inbound-error", { error: (err as Error).message });
    }
  }

  /**
   * 附件摄取：图片下载到本地缓存（url 有时效，收到即取），其余类型仅文字描述。
   * 下载失败不丢消息——描述里写明原因。
   */
  private async ingestMedia(atts: MediaAttachment[], msgId: string): Promise<string[]> {
    const lines: string[] = [];
    for (const att of atts) {
      const desc = describeAttachment(att);
      if (att.contentType.startsWith("image/") && att.url) {
        const r = await downloadAttachment(att, mediaDir(), msgId);
        lines.push(
          r.ok
            ? `[图片已存 ${r.path}（${desc}）——想看图就用 Read 工具打开这个路径（GIF 动图通常只显示首帧）]`
            : `[收到图片 ${att.filename ?? ""}（${desc}）但下载失败：${r.error}]`,
        );
      } else {
        lines.push(`[收到附件 ${att.filename ?? "未命名"}（${desc}）]`);
      }
    }
    return lines;
  }

  private rememberTarget(scope: Scope, targetId: string, msgId?: string, openid?: string): void {    this.target = { scope, targetId, ...(msgId ? { msgId } : {}), at: Date.now() };
    saveState(this.target);
    if (openid) {
      // 按人路由表：同一人再发消息（含撤回重发）自动刷新到最新 msg_id；容量限制防膨胀。
      this.recentTargets.set(openid, this.target);
      if (this.recentTargets.size > 32) {
        const oldest = [...this.recentTargets.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this.recentTargets.delete(oldest[0]);
      }
    }
  }

  /** 该目标当前仍可用的被动 msg_id（群 5 分钟 / C2C 60 分钟窗口，超时返回 undefined 走主动）。 */
  private effectiveMsgId(t: PersistedTarget, now = Date.now()): string | undefined {
    return freshMsgId(t, now, t.scope === "group" ? GROUP_PASSIVE_TTL_MS : PASSIVE_REPLY_TTL_MS);
  }

  // ------------------------------------------------------------------- claim

  /**
   * 取信决策矩阵（design.md §4，ADR-0002）。钩子经控制平面 POST /claim 调用：
   *   via=stop  —— Stop 钩子（回合结束）：inject/self-heal 以 decision:block 续跑注入。
   *   via=ups   —— UserPromptSubmit 钩子（提交提示词，0.3.0）：空闲期到达的来信随
   *                本次提示词以 additionalContext 进会话，补上"会话空闲时无 Stop 事件"
   *                的注入空窗。矩阵与副作用与 stop 完全一致。
   * 1. 最近刺激是 QQ 注入且此后未见 qq_reply 且未自愈过 → 自愈续跑（至多 1 次/刺激）。
   * 2. 否则收件箱非空 → 取 ≤3 条注入续跑。
   * 3. 否则 none（钩子输出空 JSON 正常收尾）。
   */
  claim(body: { sessionId?: string; stopHookActive?: boolean; via?: string } = {}): ClaimResult {
    this.claimSeq++;
    const via = body.via === "ups" ? "ups" : "stop";
    if (body.sessionId && this.sessionId && body.sessionId !== this.sessionId) {
      logLine("claim-none", { via, reason: "session-mismatch" });
      return { action: "none" };
    }
    const now = Date.now();
    if (
      this.lastStimulus?.kind === "inject" &&
      this.lastReplyAt < this.lastStimulus.at &&
      this.cfg?.selfHeal !== false
    ) {
      this.lastStimulus = { kind: "self-heal", at: now };
      logLine("claim-self-heal", { via });
      return { action: "self-heal", reason: SELF_HEAL_REASON };
    }
    if (this.inbox.length > 0) {
      const items = this.inbox.splice(0, CLAIM_MAX_PER_TURN);
      this.pushPending(items);
      const reason = this.injectBody(items);
      this.lastStimulus = { kind: "inject", at: now };
      logLine("claim-inject", { via, count: items.length, remaining: this.inbox.length });
      return { action: "inject", reason, count: items.length };
    }
    // v2 值守兜底：值守开启但没人挂着 qq_wait（模型漂移/回合意外结束）——拉回循环。
    // 复用 self-heal 动作形态（钩子契约不变），日志与文案区分。
    if (this.duty && this.running && this.waiterCount === 0) {
      logLine("claim-duty-continue", { via });
      return { action: "self-heal", reason: DUTY_CONTINUE_REASON };
    }
    logLine("claim-none", { via });
    return { action: "none" };
  }

  /**
   * v2 值守等待（qq_wait 工具的内核）：阻塞直到收件箱有新来信/被取消/断开/到点。
   * 到点返回"继续值守"提示（平台上限单次 30 分钟，模型随即重调形成循环，空闲零模型调用）。
   * 取走消息的语义与 claim() 一致（≤3 条/次、置 lastStimulus、bump claimSeq 让空闲通知自熄）。
   */
  async waitForInbound(maxWaitSec: number, isCancelled?: () => boolean): Promise<string> {
    if (!this.running) {
      return "QQ 未连接，无法值守：先 qq_connect（或 /qq-connect）再进入值守循环";
    }
    this.duty = true;
    this.waiterCount += 1;
    const capped = Math.min(Math.max(1, Math.round(maxWaitSec)), WAIT_MAX_SEC);
    const deadline = Date.now() + capped * 1000;
    logLine("wait-start", { maxWaitSec: capped });
    try {
      for (;;) {
        if (isCancelled?.()) {
          logLine("wait-cancelled", {});
          return "（值守等待被取消，收件箱未动。处理完当前事务后请继续调用 qq_wait）";
        }
        if (!this.running) {
          logLine("wait-disconnected", {});
          return "（QQ 已断开，值守中止。重新 qq_connect 后再恢复值守）";
        }
        if (this.inbox.length > 0) {
          const items = this.inbox.splice(0, CLAIM_MAX_PER_TURN);
          this.pushPending(items);
          this.claimSeq += 1; // 空闲通知据此自熄
          this.lastStimulus = { kind: "inject", at: Date.now() };
          logLine("wait-inject", { count: items.length, remaining: this.inbox.length });
          const body = this.injectBody(items);
          return `${body}\n（处理并回复上面的来信（qq_reply）后，必须再次调用 qq_wait 继续值守）`;
        }
        if (Date.now() >= deadline) {
          logLine("wait-timeout", {});
          return "（本轮等待到点，暂无新来信。值守继续：直接再次调用 qq_wait 即可）";
        }
        await new Promise((r) => setTimeout(r, WAIT_TICK_MS));
      }
    } finally {
      this.waiterCount -= 1;
    }
  }

  /** 退出值守循环（qq_watch_stop / /qq-watch off）：只清标志，不动连接与收件箱。 */
  stopDuty(): { duty: boolean } {
    this.duty = false;
    logLine("duty-stop", {});
    return { duty: this.duty };
  }

  /** 来信注入会话时入待回复队列（FIFO）：不带 to 的 qq_reply 按此顺序回应。 */
  private pushPending(items: InboxItem[]): void {
    for (const i of items) {
      this.pendingReplies.push({
        openid: i.openid,
        target: { scope: i.scope, targetId: i.targetId, ...(i.msgId ? { msgId: i.msgId } : {}), at: i.at },
      });
    }
    if (this.pendingReplies.length > 16) this.pendingReplies.splice(0, this.pendingReplies.length - 16);
  }

  /**
   * 取本次回复的路由目标：to 指定 → 该人最新目标并清其排队；缺省 → 弹出最早未回复者
   * （0.4.5：回复跟着驱动回合的消息走，后来的来信不再覆盖路由）；队列空 → 最近目标。
   */
  private takeReplyTarget(
    to?: string,
  ): { ok: true; target: PersistedTarget } | { ok: false; error: string } {
    if (to) {
      const t = this.recentTargets.get(to);
      this.pendingReplies = this.pendingReplies.filter((p) => p.openid !== to);
      if (!t) {
        return { ok: false, error: `没有 ${to} 的最近来信记录（窗口外或从未收到）——请让 TA 重新发一条，或省略 to 按顺序回复` };
      }
      return { ok: true, target: t };
    }
    const head = this.pendingReplies.shift();
    if (head) return { ok: true, target: head.target };
    if (this.target) return { ok: true, target: this.target };
    return { ok: false, error: "还没有回复目标：让用户在 QQ 里给机器人发一条消息" };
  }

  /** 注入文本（claim 与 qq_wait 共用）：逐条列出；多发件人时提示按人路由逐人回复。 */
  private injectBody(items: InboxItem[]): string {
    const lines = items.map((i) => {
      const t = new Date(i.at).toLocaleTimeString("zh-CN", { hour12: false });
      return `[QQ] ${i.content}（来自 ${i.openid}，${t}）`;
    });
    const senders = [...new Set(items.map((i) => i.openid))];
    if (senders.length > 1) {
      lines.push(
        `（注意：上面 ${items.length} 条来信来自 ${senders.length} 个不同的人——请对每人分别调用 qq_reply（text=给这个人的回复，to=该人的 openid），不要把不同人的回复混进一条）`,
      );
    }
    return lines.join("\n\n");
  }

  /**
   * 空闲通知（0.3.2）：消息入箱后 delay 内无人 claim → 桌面气泡 + QQ 回执。
   * 平台没有"唤醒空闲会话"的通道（v1 设计约束），这是把"消息悄悄滞留"变成
   * "用户知情、一步取回"的兜底。回执走被动回复，不消耗收件箱内容。
   */
  private scheduleIdleNotify(preview: string): void {
    if (this.cfg?.idleNotify === false && this.cfg?.idleAck === false) return;
    const seq = this.claimSeq;
    const timer = setTimeout(() => {
      this.idleTimers.delete(timer);
      if (!this.running || this.inbox.length === 0 || this.claimSeq !== seq) return;
      const now = Date.now();
      if (now - this.lastIdleNotifyAt < 60000) return; // 冷却：多条积压只提醒一次
      this.lastIdleNotifyAt = now;
      const short = preview.replace(/\s+/g, " ").slice(0, 60);
      logLine("idle-notify", { preview: short.slice(0, 40) });
      if (this.cfg?.idleNotify !== false) {
        try {
          this.notify("zcode QQ 桥", `QQ 消息待取：${short} —— 回到 zcode 输入任意一句普通文字（斜杠命令不触发取信）即可取回`);
        } catch {
          // 通知失败无碍
        }
      }
      if (this.cfg?.idleAck !== false) {
        const idleHint = this.duty
          ? "已收到 ✓（值守循环暂时中断——回到 zcode 结束当前回合即可自动恢复值守）"
          : "已收到 ✓（自动值守未开启——在 zcode 里输入 /qq-watch 开启自动值守，或随便输入一句让我立刻处理）";
        void this.sendChunks(idleHint).catch(() => {});
      }
    }, this.idleNotifyDelayMs);
    timer.unref?.();
    this.idleTimers.add(timer);
  }

  /**
   * 终端回合标记 + 镜像（控制平面 POST /terminal-mirror）。
   * 真实终端输入意味着当前回合不是 QQ 驱动 → 清除自愈条件；
   * 镜像需同时满足：已连接、forwardTerminal 开、sessionId 匹配持锁会话、非斜杠命令。
   */
  mirror(body: { sessionId?: string; text?: string } = {}): Promise<{
    ok: boolean;
    mirrored: boolean;
    reason?: string;
  }> {
    if (body.sessionId && this.sessionId && body.sessionId !== this.sessionId) {
      return Promise.resolve({ ok: false, mirrored: false, reason: "session-mismatch" });
    }
    this.lastStimulus = undefined; // 终端驱动的回合，无需自愈
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return Promise.resolve({ ok: true, mirrored: false, reason: "empty" });
    if (!this.running) return Promise.resolve({ ok: true, mirrored: false, reason: "not-connected" });
    if (!this.cfg?.forwardTerminal) return Promise.resolve({ ok: true, mirrored: false, reason: "mirror-off" });
    if (text.startsWith("/")) return Promise.resolve({ ok: true, mirrored: false, reason: "slash-command" });
    return this.sendChunks(text, TERMINAL_PREFIX).then((stats) => ({
      ok: true,
      mirrored: stats.sent > 0,
      reason: stats.sent > 0 ? undefined : this.lastError,
    }));
  }

  // ----------------------------------------------------------------- outbound

  /**
   * qq_reply：分片 → 被动优先 → 配额记账 → 耗尽降级主动。
   * 0.4.4 按人路由：to=openid 时回复该来信人（用其最新 msg_id），缺省回最近来信人——
   * 多人群聊一批多人来信时逐人回复不互踩。
   */
  async reply(text: string, to?: string): Promise<ReplyOutcome> {
    if (!this.running) return { ok: false, error: "QQ 未连接：先 qq_connect（或 /qq-connect）" };
    const body = text.trim();
    if (!body) return { ok: false, error: "回复内容为空" };
    const picked = this.takeReplyTarget(to);
    if (!picked.ok) return { ok: false, error: picked.error };
    const target = picked.target;
    this.lastReplyAt = Date.now();
    const stats = await this.sendChunks(body, undefined, target);
    const msgId = this.effectiveMsgId(target);
    if (msgId) {
      const check = this.budget.check(msgId);
      return { ok: true, stats, remaining: check.remaining, warn: budgetWarning(check.remaining, check.allowed) };
    }
    return { ok: true, stats, remaining: 0, warn: "none" };
  }

  /** 出站公共路径：分片、被动优先、配额记账；被动失败/耗尽降级主动，单片失败不阻断后续片。 */
  private async sendChunks(text: string, prefix?: string, target: PersistedTarget = this.target!): Promise<SendStats> {
    const stats: SendStats = { sent: 0, passive: 0, proactive: 0 };
    if (!this.bot || !target) {
      logLine("outbound-skip", { reason: !this.bot ? "no-bot" : "no-target" });
      return stats;
    }
    const body = prefix ? `${prefix}\n${text}` : text;
    const limit = this.cfg?.maxChunkChars ?? 4500;
    for (const chunk of chunkText(body, limit)) {
      if (!chunk.trim()) continue;
      let msgId = this.effectiveMsgId(target);
      if (msgId) {
        const check = this.budget.check(msgId);
        if (!check.allowed) {
          logLine("budget-exhausted", { msgId, remaining: check.remaining, limit: PASSIVE_REPLY_LIMIT });
          msgId = undefined; // 降级主动消息
        }
      }
      const scope = target.scope;
      const targetId = target.targetId;
      try {
        if (msgId) {
          await this.bot.sendText({ scope, targetId, msgId }, chunk);
        } else {
          await this.bot.sendText({ scope, targetId }, chunk);
        }
      } catch (err) {
        this.lastError = (err as Error).message;
        if (msgId) {
          // 被动发送失败（msg_id 被撤回/超窗等）→ 降级主动重试一次，别让回复无声蒸发。
          logLine("outbound-error", { error: this.lastError, fallback: "proactive" });
          try {
            await this.bot.sendText({ scope, targetId }, chunk);
            stats.sent += 1;
            stats.proactive += 1;
            this.outCount += 1;
            logLine("outbound", { mode: "proactive-fallback", chars: chunk.length, preview: chunk.slice(0, 80) });
            continue;
          } catch (err2) {
            this.lastError = (err2 as Error).message;
            logLine("outbound-error", { error: this.lastError, fallback: "failed" });
            continue;
          }
        }
        logLine("outbound-error", { error: this.lastError });
        continue;
      }
      if (msgId) this.budget.record(msgId);
      stats.sent += 1;
      if (msgId) stats.passive += 1;
      else stats.proactive += 1;
      this.outCount += 1;
      logLine("outbound", { mode: msgId ? "passive" : "proactive", chars: chunk.length, preview: chunk.slice(0, 80) });
    }
    return stats;
  }

  // --------------------------------------------------------------------- bind

  /** 进入绑定态；未连接则先连接（/qq-bind 自动起传输）。 */
  async bindStart(): Promise<{ ok: true; message: string } | { ok: false; error: string; holder?: LockInfo }> {
    if (!this.running) {
      const r = await this.connect();
      if (!r.ok) return r;
    }
    this.bindMode = true;
    logLine("bind-start", {});
    return { ok: true, message: "请在 QQ 私聊机器人发任意一条消息完成绑定" };
  }

  /** 长轮询待确认 openid（双确认第一步的结果）。 */
  async bindPending(timeoutSec = 60): Promise<{ ok: true; openid: string | null } | { ok: false; error: string }> {
    const timeout = Math.min(Math.max(1, Math.round(timeoutSec)), 60) * 1000;
    const deadline = Date.now() + timeout;
    while (!this.pendingBind && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
    }
    return { ok: true, openid: this.pendingBind?.openid ?? null };
  }

  /** 双确认第二步：openid 必须与待确认一致，写白名单并记住目标。 */
  async bindConfirm(openid: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!openid?.trim()) return { ok: false, error: "openid 为空" };
    const id = openid.trim();
    if (!this.pendingBind) return { ok: false, error: "没有待确认的绑定请求（先 qq_bind_start + qq_bind_pending）" };
    if (this.pendingBind.openid !== id) {
      return { ok: false, error: `openid 不一致：待确认 ${this.pendingBind.openid}，收到 ${id}` };
    }
    const saved = saveAllowFrom([id]);
    if (!saved.ok) return { ok: false, error: `保存失败：${saved.error}` };
    if (this.cfg) this.cfg.allowFrom = [id];
    this.rememberTarget(this.pendingBind.scope, this.pendingBind.targetId, this.pendingBind.msgId, this.pendingBind.openid);
    this.pendingBind = undefined;
    logLine("bound", { openid: id });
    return { ok: true };
  }

  // ------------------------------------------------------------------ config

  /** qq_setup / qq_config 共用：受控写配置并热更新内存。 */
  async applyConfig(patch: Partial<QQBotConfig>): Promise<{ ok: true; saved: string; needsReconnect: boolean } | { ok: false; error: string }> {
    const allowed: (keyof QQBotConfig)[] = [
      "appId", "appSecret", "markdownSupport", "allowFrom", "allowGroup", "allowGroupFrom",
      "autoConnect", "maxChunkChars", "forwardTerminal", "selfHeal",
      "idleNotify", "idleAck",
    ];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch && patch[k] !== undefined) clean[k] = patch[k];
    }
    if (Object.keys(clean).length === 0) return { ok: false, error: "没有可写字段" };
    if (clean.appSecret !== undefined && typeof clean.appSecret !== "string") {
      return { ok: false, error: "appSecret 必须是字符串" };
    }
    const structural = "appId" in clean || "appSecret" in clean || "markdownSupport" in clean;
    const saved = saveConfig(clean as Partial<QQBotConfig>);
    if (!saved.ok) return { ok: false, error: `保存失败：${saved.error}` };
    const reloaded = loadConfig();
    if (reloaded.ok) this.cfg = reloaded.config;
    logLine("config-updated", { keys: Object.keys(clean) });
    return { ok: true, saved: configPath(), needsReconnect: structural && this.running };
  }

  // ------------------------------------------------------------------ status

  health(): Record<string, unknown> {
    return {
      ok: true,
      running: this.running,
      ready: this.ready,
      sessionId: this.sessionId,
      inboxCount: this.inbox.length,
      // 与锁文件里的 pid 同源（接管方用来核对"响应的就是持锁者"）。
      pid: this.lockPid ?? process.pid,
    };
  }

  status(): Record<string, unknown> {
    const holder = readLock();
    const msgId = this.target?.msgId;
    return {
      running: this.running,
      ready: this.ready,
      sessionId: this.sessionId,
      lock: holder ? { pid: holder.pid, host: holder.host, port: holder.port, sessionId: holder.sessionId } : null,
      config: configPath(),
      allowFrom: this.cfg?.allowFrom ?? [],
      allowGroup: this.cfg?.allowGroup ?? false,
      allowGroupFrom: this.cfg?.allowGroupFrom ?? [],
      target: this.target ? `${this.target.scope}:${this.target.targetId}` : null,
      passiveBudget: msgId ? `${this.budget.remaining(msgId)} / ${PASSIVE_REPLY_LIMIT}` : "-",
      inboxCount: this.inbox.length,
      inboxPreview: this.inbox.slice(0, 3).map((i) => i.content.slice(0, 40)),
      bindMode: this.bindMode,
      pendingBindOpenid: this.pendingBind?.openid ?? null,
      duty: this.duty,
      dutyWaiters: this.waiterCount,
      forwardTerminal: this.cfg?.forwardTerminal ?? false,
      selfHeal: this.cfg?.selfHeal ?? true,
      autoConnect: this.cfg?.autoConnect ?? false,
      maxChunkChars: this.cfg?.maxChunkChars ?? 4500,
      idleNotify: this.cfg?.idleNotify ?? true,
      idleAck: this.cfg?.idleAck ?? true,
      sent: this.outCount,
      lastError: this.lastError ?? null,
    };
  }
}
