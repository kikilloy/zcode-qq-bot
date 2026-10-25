/**
 * MCP stdio 服务器入口（M3 完整版）：换行分隔 JSON-RPC 2.0 + 内嵌网关 + 控制平面。
 * 工具面 = design.md §3（qq_pair_pending 是 §5 配对流程的自然补充，长轮询扫码结果）。
 * stdout 只走协议；网关诊断走 log.jsonl。会话 id 优先取 manifest env 注入的
 * ZCODE_QQBOT_SESSION_ID（${CLAUDE_SESSION_ID} 模板展开），失败降级缺省。
 */

import { createInterface } from "node:readline";
import { startControlPlane, type ControlPlaneBackend } from "./control-plane.ts";
import { Gateway } from "./gateway.ts";
import { PairManager } from "./pair.ts";
import { logLine } from "./log.ts";

const SERVER_INFO = { name: "zcode-qqbot", version: "0.4.5" };

// ------------------------------------------------------------------ bootstrap

const gateway = new Gateway();
const pairManager = new PairManager({
  onCredentials: (appId, appSecret) =>
    gateway.applyConfig({ appId, appSecret }).then((r) => {
      if (!r.ok) throw new Error(r.error);
    }),
});

let controlPlanePort: number | undefined;
let controlPlaneClosed = false;

void (async () => {
  try {
    // 网关实现控制平面后端（health/claim/mirror）；监听拿到端口后回填进锁文件。
    const cp = await startControlPlane(gateway as ControlPlaneBackend);
    controlPlanePort = cp.port;
    gateway.setPort(cp.port);
    await gateway.init();
    logLine("mcp-bootstrap-done", { port: cp.port, sessionId: gateway.sessionId ?? null });
  } catch (err) {
    logLine("mcp-bootstrap-error", { error: (err as Error).message });
  }
})();

// --------------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * 工具级超时声明（V0 真机实测）：zcode agent 层采信
   * tools/list 条目 _meta.timeoutMs，有效域 1s–30min；不声明则默认 30s。仅 qq_wait 用。
   */
  metaTimeoutMs?: number;
  /** ctx.isCancelled：宿主已对该请求发 notifications/cancelled（长等待工具据此收尾，不动收件箱）。 */
  handler: (args: Record<string, unknown>, ctx: { isCancelled: () => boolean }) => Promise<string>;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

function numArg(args: Record<string, unknown>, key: string, dflt: number): number {
  const v = args[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function warnText(warn: string): string {
  if (warn === "exhausted") return "（被动额度已用尽，本条走了主动消息，可能被 QQ 拦截；在 QQ 里发条新消息即可刷新额度）";
  if (warn === "low") return "（被动额度仅剩 1 次，建议让用户在 QQ 里发条新消息刷新）";
  return "";
}

const TOOLS: ToolDef[] = [
  {
    name: "qq_ping",
    description: "端到端连通性检查：返回 pong 与网关进程/控制平面信息",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () =>
      `pong：zcode-qqbot ${SERVER_INFO.version}，pid=${process.pid}，控制平面=127.0.0.1:${controlPlanePort ?? "未就绪"}，${new Date().toISOString()}`,
  },
  {
    name: "qq_status",
    description: "全状态只读：连接/锁/白名单/目标/被动配额/收件箱/绑定待办/配对状态/最近错误/镜像与自愈开关",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => JSON.stringify({ ...gateway.status(), pairing: pairManager.status() }, null, 2),
  },
  {
    name: "qq_connect",
    description: "连接 QQ 网关（抢单实例锁；被其他会话占用时自动请对方让位接管——桥跟着最后手动连接的会话走）。未配凭据时先 /qq-pair 或 qq_setup",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await gateway.connect({ takeover: true });
      if (!r.ok) return `连接失败：${r.error}`;
      const tookNote = r.takeover ? "（已从原持锁会话接管）" : "";
      const waited = await gateway.waitReady(4000);
      if (waited === "ready") return `QQ 已连接 ✓${tookNote}（网关在线，钩子开始取信）`;
      if (waited === "error") {
        const st = gateway.status();
        return `连接已发起但出错：${st.lastError ?? "未知错误"}（详见 ~/.zcode/qqbot/log.jsonl）`;
      }
      return `连接中…${tookNote}（WS 握手超过 4 秒仍在进行，稍后用 qq_status 确认 ready）`;
    },
  },
  {
    name: "qq_disconnect",
    description: "断开 QQ 网关并释放单实例锁（换会话连接前必须先断）",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      gateway.disconnect("qq_disconnect");
      return "已断开，锁已释放";
    },
  },
  {
    name: "qq_setup",
    description: "手动写入凭据（appId + appSecret，QQ 开放平台 https://q.qq.com 的机器人页获取）并保存到本机配置文件；扫码配对请改用 /qq-pair",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", description: "QQ 开放平台 AppID" },
        appSecret: { type: "string", description: "QQ 开放平台 AppSecret（只落本机 0600 文件，不进日志）" },
      },
      required: ["appId", "appSecret"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const appId = strArg(args, "appId");
      const appSecret = strArg(args, "appSecret");
      if (!appId || !appSecret) return "appId / appSecret 不能为空";
      const r = await gateway.applyConfig({ appId, appSecret });
      if (!r.ok) return `保存失败：${r.error}`;
      return `凭据已保存到 ${r.saved}${r.needsReconnect ? "；当前已连接，凭据改动需 qq_disconnect 后重新 qq_connect 生效" : "。下一步：/qq-connect（或 qq_connect）"}`;
    },
  },
  {
    name: "qq_pair_start",
    description:
      "发起扫码配对：返回二维码（SVG + 纯文本 + URL）。把二维码立即内联展示给用户（SVG 优先，包进白色背景的 HTML 片段），用手机 QQ 扫码；然后用 qq_pair_pending 轮询结果",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await pairManager.start();
      if (!r.ok) return `配对发起失败：${r.error}`;
      return [
        `扫码配对已发起（pairingId=${r.pairingId}）。`,
        ``,
        `二维码 URL：${r.url}`,
        ``,
        `二维码 SVG（主展示渠道，衬白底内联渲染）：`,
        r.svg,
        ``,
        `纯文本二维码（等宽字体 + 浅色背景时可用）：`,
        r.ascii,
        ``,
        `请立即把二维码展示给用户（不要只给链接），随后调用 qq_pair_pending 等待扫码结果。`,
      ].join("\n");
    },
  },
  {
    name: "qq_pair_pending",
    description: "轮询扫码配对结果。status=success 表示凭据已自动写入配置，可直接 /qq-connect；pending=还在等扫码；failed=失败",
    inputSchema: {
      type: "object",
      properties: { pairingId: { type: "string" }, timeoutSec: { type: "number", description: "等待秒数，≤120，默认 25（宿主工具调用约 30s 超时，勿设更大）" } },
      required: ["pairingId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const pairingId = strArg(args, "pairingId");
      const timeoutSec = numArg(args, "timeoutSec", 25);
      const r = await pairManager.pending(pairingId, timeoutSec);
      if (r.status === "success") return `配对成功 ✓ appId=${r.appId}，凭据已写入配置文件。下一步：/qq-connect（或 qq_connect 工具）`;
      if (r.status === "failed") return `配对失败：${r.error ?? "未知原因"}。可重新 /qq-pair，或用 /qq-setup 手动填凭据`;
      if (r.status === "unknown") return "pairingId 不存在（可能已过期）。重新 /qq-pair 发起";
      return "仍在等待扫码…（可再次调用本工具继续等，或提醒用户扫码）";
    },
  },
  {
    name: "qq_config",
    description: "受控改配置：allowFrom/allowGroup/allowGroupFrom（群开放名单）/forwardTerminal/autoConnect/maxChunkChars/selfHeal/idleNotify/idleAck/markdownSupport/appId/appSecret。改凭据类字段后需重连",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "object",
          description: "要修改的字段集合，如 {\"forwardTerminal\": true}",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const patch = args.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "patch 必须是对象";
      const r = await gateway.applyConfig(patch as Record<string, never>);
      if (!r.ok) return `保存失败：${r.error}`;
      const st = gateway.status();
      return `配置已保存到 ${r.saved}。当前生效：forwardTerminal=${st.forwardTerminal}，selfHeal=${st.selfHeal}，autoConnect=${st.autoConnect}，maxChunkChars=${st.maxChunkChars}${r.needsReconnect ? "。注意：凭据类改动需 qq_disconnect 后重新 qq_connect" : ""}`;
    },
  },
  {
    name: "qq_bind_start",
    description: "进入绑定态：用户下一条 QQ 私聊消息进待确认（不入收件箱）。未连接会自动连接。之后用 qq_bind_pending 取 openid",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await gateway.bindStart();
      if (!r.ok) return `绑定流程启动失败：${r.error}`;
      return r.message;
    },
  },
  {
    name: "qq_bind_pending",
    description: "长轮询绑定待确认 openid（默认 60s）。拿到 openid 后展示给用户，用户口头同意才可调 qq_bind_confirm",
    inputSchema: {
      type: "object",
      properties: { timeoutSec: { type: "number", description: "等待秒数，≤60，默认 60" } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const timeoutSec = numArg(args, "timeoutSec", 60);
      const r = await gateway.bindPending(timeoutSec);
      if (!r.ok) return r.error;
      if (!r.openid) return "超时未收到绑定消息。请确认用户已在 QQ 私聊发消息，然后重试（绑定态保持中）";
      return `待确认 openid：${r.openid}\n请向用户展示并确认这是本人，同意后调用 qq_bind_confirm`;
    },
  },
  {
    name: "qq_bind_confirm",
    description: "双确认第二步：写入 allowFrom 白名单。必须在用户口头同意后调用，openid 须与待确认一致",
    inputSchema: {
      type: "object",
      properties: { openid: { type: "string" } },
      required: ["openid"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const openid = strArg(args, "openid");
      const r = await gateway.bindConfirm(openid);
      if (!r.ok) return `绑定失败：${r.error}`;
      return `已绑定 ${openid} ✓（写入白名单）。现在 QQ 侧的消息会进入会话，可用 qq_reply 回复`;
    },
  },
  {
    name: "qq_reply",
    description:
      "向 QQ 发文本：自动分片、被动回复优先、配额记账、被动失败/耗尽降级主动消息。模型完成回复后必须调用本工具把内容发到 QQ。一批来信有多个不同发件人时，对每人分别调用并带 to=该人 openid",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要发送的完整回复内容" },
        to: { type: "string", description: "可选，回复对象的 openid（按人路由，用其最新来信 msg_id）；缺省回复最近来信人" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const text = strArg(args, "text");
      if (!text) return "text 不能为空";
      const to = strArg(args, "to") || undefined;
      const r = await gateway.reply(text, to);
      if (!r.ok) return `发送失败：${r.error}`;
      const st = gateway.status();
      const suffix = r.warn === "none" ? "" : warnText(r.warn);
      return `已发送 ${r.stats.sent} 片（被动 ${r.stats.passive} / 主动 ${r.stats.proactive}），当前来信被动余量 ${st.passiveBudget}${suffix}`;
    },
  },
  {
    name: "qq_wait",
    description:
      "值守等待（v2 值守循环的核心）：阻塞直到下一条 QQ 来信到达才返回其内容。用法纪律：①进入值守后调用本工具；②返回来信 → 处理并 qq_reply 回复 → 立即再次调用本工具；③返回「到点无来信」 → 直接再次调用本工具。除被取消/断开外，值守期间每次事情做完后的下一个动作永远是本工具。单次最长 30 分钟（平台上限），等待期间不消耗任何 token",
    inputSchema: {
      type: "object",
      properties: {
        maxWaitSec: { type: "number", description: "单次最长等待秒数，默认 1740（29 分钟），上限 1800" },
      },
      additionalProperties: false,
    },
    metaTimeoutMs: 1800000,
    handler: async (args, ctx) => gateway.waitForInbound(numArg(args, "maxWaitSec", 1740), ctx.isCancelled),
  },
  {
    name: "qq_watch_stop",
    description: "退出值守循环（/qq-watch off）：此后回合正常结束、不再自动等待 QQ 来信。连接与收件箱不受影响",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      gateway.stopDuty();
      return "已退出值守循环 ✓（QQ 保持连接；需要时 /qq-watch 重新开启）";
    },
  },
];

// ------------------------------------------------------------- JSON-RPC loop

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

async function route(message: JsonRpcMessage, ctx: { isCancelled: () => boolean }): Promise<unknown> {
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return {
        protocolVersion: typeof requested === "string" ? requested : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(({ name, description, inputSchema, metaTimeoutMs }) => ({
          name,
          description,
          inputSchema,
          ...(metaTimeoutMs !== undefined ? { _meta: { timeoutMs: metaTimeoutMs } } : {}),
        })),
      };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw new RpcError(-32602, `unknown tool: ${String(params.name)}`);
      try {
        const text = await tool.handler((params.arguments ?? {}) as Record<string, unknown>, ctx);
        return { content: [{ type: "text", text }] } satisfies ToolResult;
      } catch (error) {
        return {
          content: [{ type: "text", text: `工具执行失败：${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        } satisfies ToolResult;
      }
    }
    default:
      throw new RpcError(-32601, `method not found: ${String(message.method)}`);
  }
}

function reply(id: JsonRpcId, payload: { result?: unknown; error?: unknown }): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}

/** 已被宿主取消的请求 id（notifications/cancelled 记账；qq_wait 轮询它收尾）。 */
const cancelledIds = new Set<string>();

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    return; // 非 JSON 行直接丢弃，不回应
  }
  if (message.id === undefined || message.id === null) {
    // 通知不回应，但 cancellation 要记账：长等待工具（qq_wait）据此收尾且不动收件箱。
    if (message.method === "notifications/cancelled") {
      const rid = (message.params as { requestId?: unknown } | undefined)?.requestId;
      if (rid !== undefined) cancelledIds.add(String(rid));
      logLine("rpc-cancelled", { requestId: rid === undefined ? null : String(rid) });
    }
    return;
  }
  const id = message.id;
  cancelledIds.delete(String(id)); // 复用 id 的可能性极低，防御性清理
  const ctx = { isCancelled: () => cancelledIds.has(String(id)) };
  route(message, ctx)
    .then((result) => reply(id, { result }))
    .catch((error: unknown) =>
      reply(id, {
        error:
          error instanceof RpcError
            ? { code: error.code, message: error.message }
            : { code: -32603, message: error instanceof Error ? error.message : String(error) },
      }),
    )
    .finally(() => cancelledIds.delete(String(id)));
});
rl.on("close", () => {
  // 会话退出：优雅断开 QQ、释放锁、关控制平面。
  if (!controlPlaneClosed) {
    controlPlaneClosed = true;
    try {
      gateway.shutdown();
    } catch (err) {
      logLine("shutdown-error", { error: (err as Error).message });
    }
  }
  process.exit(0);
});
