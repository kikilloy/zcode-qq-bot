/**
 * zcode-qqbot — 纯逻辑核心，零依赖、无 I/O，`node --test` 直接测。
 *
 * 平台事实（QQ 开放平台文档 + @tencent-connect/qqbot-nodejs SDK 源码，已实测验证）：
 *   - 单条文本消息上限约 5000 字符；
 *   - 每条 C2C 来信只允许 4 次被动回复，来信 msg_id 60 分钟内有效（群：5 次 / 5 分钟）；
 *   - sendText 不会替你分片。
 *
 * 只保留 v1 用得到的分片/配额；Debouncer（中间消息流式）、extractText /
 * formatToolTrace / composePayload（扩展模型专属/工具轨迹）不在本插件范围。
 */

/** 注入 zcode 会话的 QQ 来信前缀标记，防止模型把它当普通终端输入回显。 */
export const QQ_MARKER = "[QQ]";

/** 每条来信的被动回复配额（C2C）。 */
export const PASSIVE_REPLY_LIMIT = 4;
/** 被动回复有效期窗口（C2C，60 分钟）。 */
export const PASSIVE_REPLY_TTL_MS = 60 * 60 * 1000;
/** 单条消息安全分片长度，留余量在 ~5000 字符平台上限之下。 */
export const DEFAULT_MAX_CHUNK_CHARS = 4500;

export interface BudgetCheck {
  allowed: boolean;
  remaining: number;
}

/**
 * 按来信 msg_id 记账的被动回复配额。
 * 配额耗尽或窗口过期后，调用方必须降级为主动消息（不带 msg_id）或保持沉默。
 */
export class ReplyBudget {
  private readonly records = new Map<string, { count: number; firstAt: number }>();
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    limit: number = PASSIVE_REPLY_LIMIT,
    ttlMs: number = PASSIVE_REPLY_TTL_MS,
    now: () => number = () => Date.now(),
  ) {
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** msgId 是否还允许下一次被动回复。 */
  check(msgId: string): BudgetCheck {
    const rec = this.records.get(msgId);
    if (!rec) return { allowed: true, remaining: this.limit };
    if (this.now() - rec.firstAt > this.ttlMs) {
      this.records.delete(msgId);
      return { allowed: true, remaining: this.limit };
    }
    const remaining = this.limit - rec.count;
    return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
  }

  /** 对 msgId 记一次被动回复。 */
  record(msgId: string): void {
    const t = this.now();
    const rec = this.records.get(msgId);
    if (!rec || t - rec.firstAt > this.ttlMs) {
      this.records.set(msgId, { count: 1, firstAt: t });
    } else {
      rec.count += 1;
    }
  }

  /** msgId 剩余被动配额（qq_status 展示用）。 */
  remaining(msgId: string): number {
    return this.check(msgId).remaining;
  }

  reset(msgId?: string): void {
    if (msgId === undefined) this.records.clear();
    else this.records.delete(msgId);
  }

  size(): number {
    return this.records.size;
  }
}

/**
 * 把文本切成不超过 limit 的分片，优先段落 / 换行 / 空格边界；
 * 找不到边界（长 URL、base64、压缩代码）时硬切。
 */
export function chunkText(text: string, limit: number = DEFAULT_MAX_CHUNK_CHARS): string[] {
  if (!text) return [];
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text];

  const out: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const win = rest.slice(0, limit);
    let cut = win.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = win.lastIndexOf("\n");
    if (cut < limit * 0.5) cut = win.lastIndexOf(" ");
    if (cut <= 0) cut = limit;

    let head = rest.slice(0, cut);
    if (!head.trim()) {
      cut = limit;
      head = rest.slice(0, cut);
    }

    out.push(head.replace(/\s+$/, ""));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }

  if (rest.length > 0) out.push(rest);
  return out.filter((c) => c.length > 0);
}

/** QQ 来信注入会话前打标记。 */
export function markInjected(text: string): string {
  return `${QQ_MARKER} ${text}`;
}

/** 判断一条用户消息是否来自 QQ 注入（禁止再回显回 QQ）。 */
export function isInjected(text: string): boolean {
  return text.trimStart().startsWith(QQ_MARKER);
}

/** 剩余被动配额的紧迫程度。 */
export type BudgetWarning = "none" | "low" | "exhausted";

/**
 * 给用户面的余量提示分级。remaining 是本次发送**之前**仍可用的条数。
 */
export function budgetWarning(remaining: number, allowed: boolean): BudgetWarning {
  if (!allowed) return "exhausted";
  if (remaining <= 1) return "low";
  return "none";
}
