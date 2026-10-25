/**
 * 入站媒体处理（0.4.2）：QQ 表情标签解码 + 图片附件归一与下载。
 *
 * 真机实证（2026-10-25 V1 验收）：
 * - 商城表情/小黄脸在 content 里是 <faceType=N,faceId="X",ext="base64(json)"> 标签，
 *   ext 解出的 {"text":"..."} 是表情名（商城表情常为空串——QQ 只下发 ID，不给图）。
 * - 图片/GIF 消息 content 为空、媒体在 attachments（官方文档：url 有时效，需及时下载）。
 * 路径每次解析，方便测试与 env 覆盖（与 log/state 同一模式）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logLine } from "./log.ts";

/** 单条消息最多处理的附件数（防御异常报文）。 */
export const MAX_ATTACHMENTS = 4;
/** 单个附件下载的大小上限。 */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
/** 附件下载超时（附件 url 有时效，超时只影响该附件的描述）。 */
export const DOWNLOAD_TIMEOUT_MS = 15_000;

export interface MediaAttachment {
  contentType: string;
  url?: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
}

/** 媒体缓存根目录（按消息落子文件）。 */
export function mediaDir(): string {
  return process.env.ZCODE_QQBOT_MEDIA || path.join(os.homedir(), ".zcode", "qqbot", "media");
}

const FACE_TAG = /<faceType\s*=\s*(\d+)\s*,\s*faceId\s*=\s*"?([^",>]*)"?\s*(?:,\s*ext\s*=\s*"([^"]*)")?\s*\/?>/g;

/** 解码 content 里的表情标签为可读文字（位置保持不变）。 */
export function decodeFaceTags(content: string): string {
  return content.replace(FACE_TAG, (_m, type: string, faceId: string, ext?: string) => {
    const text = faceExtText(ext ?? "");
    if (text) return `[表情:${text}]`;
    if (type === "1") return `[小黄脸表情#${faceId}]`;
    return `[大表情 faceType=${type} faceId=${faceId}（QQ 只下发 ID，不下发图片）]`;
  });
}

/** ext 是 base64(json {"text": "..."})；解析失败返回空串。 */
function faceExtText(ext: string): string {
  if (!ext) return "";
  try {
    const parsed = JSON.parse(Buffer.from(ext, "base64").toString("utf8")) as { text?: unknown };
    return typeof parsed?.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

/** 归一化消息里的附件：顶层 attachments + msg_elements[].attachments（新版报文形态）。 */
export function collectAttachments(msg: unknown): MediaAttachment[] {
  const m = (msg ?? {}) as Record<string, any>;
  const raw: any[] = [];
  if (Array.isArray(m.attachments)) raw.push(...m.attachments);
  if (Array.isArray(m.msgElements)) {
    for (const el of m.msgElements) if (Array.isArray(el?.attachments)) raw.push(...el.attachments);
  }
  const out: MediaAttachment[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const contentType = String(a.content_type ?? "").toLowerCase();
    if (!contentType) continue;
    const url = typeof a.url === "string" && /^https?:\/\//i.test(a.url) ? a.url : undefined;
    const filename = typeof a.filename === "string" && a.filename.trim() ? a.filename.trim() : undefined;
    const key = `${url ?? ""}|${filename ?? ""}|${contentType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      contentType,
      url,
      filename,
      width: toPosInt(a.width),
      height: toPosInt(a.height),
      size: toPosInt(a.size),
    });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

/** 附件的一句话描述：image/gif 240×240 123.4KB。 */
export function describeAttachment(att: MediaAttachment): string {
  const parts: string[] = [att.contentType];
  if (att.width && att.height) parts.push(`${att.width}×${att.height}`);
  if (att.size) parts.push(formatSize(att.size));
  return parts.join(" ");
}

/**
 * 下载图片附件到媒体缓存目录。成功返回 {ok, path}；失败返回 {ok:false, error}
 * （下载失败不影响消息入箱，只是描述里说明原因）。
 */
export async function downloadAttachment(
  att: MediaAttachment,
  dir: string = mediaDir(),
  stem: string = "msg",
): Promise<{ ok: true; path: string; bytes: number } | { ok: false; error: string }> {
  if (!att.url) return { ok: false, error: "无下载地址" };
  if (att.size && att.size > MAX_MEDIA_BYTES) return { ok: false, error: `超过 ${formatSize(MAX_MEDIA_BYTES)} 上限` };
  try {
    const res = await fetch(att.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, error: "空文件" };
    if (buf.length > MAX_MEDIA_BYTES) return { ok: false, error: `超过 ${formatSize(MAX_MEDIA_BYTES)} 上限` };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sanitizeFileStem(stem)}-${Date.now().toString(36)}.${extOf(att)}`);
    fs.writeFileSync(file, buf);
    logLine("media-saved", { file, bytes: buf.length, contentType: att.contentType });
    return { ok: true, path: file, bytes: buf.length };
  } catch (err) {
    const error = (err as Error).message?.slice(0, 120) ?? "下载异常";
    logLine("media-error", { error, url: att.url.slice(0, 120) });
    return { ok: false, error };
  }
}

/** 文件名主干只留安全字符（messageId 可能含怪字符）。 */
function sanitizeFileStem(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return clean || "msg";
}

/** 扩展名白名单：content_type/文件名两处推断，兜底 bin。 */
function extOf(att: MediaAttachment): string {
  const fromName = att.filename ? (att.filename.split(".").pop() ?? "") : "";
  if (/^(png|jpg|jpeg|gif|webp|bmp)$/i.test(fromName)) return fromName.toLowerCase();
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
  };
  return map[att.contentType] ?? "bin";
}

function toPosInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
