/**
 * 配置加载 / 校验 / 持久化。文件 0600（含 appSecret，凭据只落本机，绝不进日志）。
 * 字段面向本插件裁剪：不含 debounceMs / streamIntermediate / showToolTrace，
 * 含 selfHeal；forwardTerminal 默认 false（用户锁定决策：默认关、手动开）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_CHUNK_CHARS } from "./core.ts";

export interface QQBotConfig {
  appId: string;
  appSecret: string;
  /** Bot 有 QQ Markdown 权限。未过审保持 false。 */
  markdownSupport: boolean;
  /** 允许驱动会话的 QQ openid 白名单。空 = 只能走绑定流程。 */
  allowFrom: string[];
  /** 每条消息分片长度（字符）。 */
  maxChunkChars: number;
  /** 终端镜像：把 zcode 里输入的提示词转发到 QQ。默认关。 */
  forwardTerminal: boolean;
  /** 同时接受群 @ 消息（v1 不启用，字段预留）。 */
  allowGroup: boolean;
  /** MCP 服务器启动即连 QQ。0.3.0 起默认 true（用户 2026-10-25：跨会话免手动连接）；要常关用 qq_config。 */
  autoConnect: boolean;
  /** 模型忘调 qq_reply 时，Stop 钩子续跑提醒（每回合至多 1 次）。 */
  selfHeal: boolean;
  /** 消息入箱后长时间无人取 → 弹桌面通知（0.3.2，默认开）。 */
  idleNotify: boolean;
  /** 消息入箱后长时间无人取 → 给 QQ 发一条回执（0.3.2，默认开）。 */
  idleAck: boolean;
}

export type LoadResult =
  | { ok: true; config: QQBotConfig; path: string }
  | { ok: false; error: string; path: string };

export function configPath(): string {
  return process.env.ZCODE_QQBOT_CONFIG || path.join(os.homedir(), ".zcode", "qqbot", "config.json");
}

function clampInt(value: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0);
}

/** 把原始解析对象校验并归一化为配置。 */
export function normalizeConfig(raw: unknown, filePath = configPath()): LoadResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, path: filePath, error: "配置必须是 JSON 对象" };
  }
  const r = raw as Record<string, unknown>;

  const appId = typeof r.appId === "string" ? r.appId.trim() : "";
  const appSecret = typeof r.appSecret === "string" ? r.appSecret.trim() : "";
  if (!appId) return { ok: false, path: filePath, error: "缺少 appId" };
  if (!appSecret) return { ok: false, path: filePath, error: "缺少 appSecret" };
  if (appId.startsWith("YOUR_") || appSecret.startsWith("YOUR_")) {
    return { ok: false, path: filePath, error: `请先在 ${filePath} 填入真实的 appId / appSecret` };
  }

  const config: QQBotConfig = {
    appId,
    appSecret,
    markdownSupport: r.markdownSupport === true,
    allowFrom: strArray(r.allowFrom),
    maxChunkChars: clampInt(r.maxChunkChars, 500, 4800, DEFAULT_MAX_CHUNK_CHARS),
    forwardTerminal: r.forwardTerminal === true,
    allowGroup: r.allowGroup === true,
    autoConnect: r.autoConnect !== false,
    selfHeal: r.selfHeal !== false,
    idleNotify: r.idleNotify !== false,
    idleAck: r.idleAck !== false,
  };

  return { ok: true, config, path: filePath };
}

export function loadConfig(filePath = configPath()): LoadResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, path: filePath, error: `配置文件不存在：${filePath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return { ok: false, path: filePath, error: `配置文件解析失败：${(err as Error).message}` };
  }
  return normalizeConfig(parsed, filePath);
}

function writeMerged(filePath: string, patch: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch {
      // 文件损坏时直接用 patch 覆盖重建。
    }
  }
  const merged = { ...existing, ...patch };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 持久化白名单（qq_bind_confirm 用）。文件 0600。 */
export function saveAllowFrom(openids: string[], filePath = configPath()): { ok: true } | { ok: false; error: string } {
  return writeMerged(filePath, { allowFrom: strArray(openids) });
}

/** 持久化任意配置补丁（qq_setup / qq_config 用）。文件 0600。 */
export function saveConfig(
  patch: Partial<QQBotConfig>,
  filePath = configPath(),
): { ok: true } | { ok: false; error: string } {
  return writeMerged(filePath, patch as Record<string, unknown>);
}

/**
 * 0.3.0 迁移：0.2.x 写出的配置把 autoConnect 固定成默认 false——那不是用户选择，
 * 而是旧默认值落盘。无 configVersion 的旧文件统一改成新默认 true 并打上标记；
 * 之后用户再用 qq_config 显式改回 false 不会被二次迁移（configVersion 已存在）。
 */
export function migrateConfig(filePath = configPath()): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    if ((parsed as Record<string, unknown>).configVersion === 1) return;
    writeMerged(filePath, { configVersion: 1, autoConnect: true });
  } catch {
    // 迁移失败不阻断启动，按原文件内容加载
  }
}

/** 配置文件不存在时创建入门样例。 */
export function ensureExampleConfig(filePath = configPath()): { created: boolean } {
  if (fs.existsSync(filePath)) return { created: false };
  const sample = {
    appId: "YOUR_QQBOT_APP_ID",
    appSecret: "YOUR_QQBOT_APP_SECRET",
    markdownSupport: false,
    allowFrom: [] as string[],
    maxChunkChars: DEFAULT_MAX_CHUNK_CHARS,
    forwardTerminal: false,
    allowGroup: false,
    autoConnect: true,
    selfHeal: true,
    idleNotify: true,
    idleAck: true,
    configVersion: 1,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(sample, null, 2)}\n`, { mode: 0o600 });
    return { created: true };
  } catch {
    return { created: false };
  }
}
