import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  MAX_ATTACHMENTS,
  collectAttachments,
  decodeFaceTags,
  describeAttachment,
  downloadAttachment,
  mediaDir,
} from "../src/media.ts";

test("decodeFaceTags: 小黄脸带名字", () => {
  // 真机抓包：eyJ0ZXh0Ijoi55aR6ZeuIn0= 解出 {"text":"疑问"}
  const raw = '哈哈<faceType=1,faceId="32",ext="eyJ0ZXh0Ijoi55aR6ZeuIn0=">';
  assert.equal(decodeFaceTags(raw), "哈哈[表情:疑问]");
});

test("decodeFaceTags: 商城大表情无名字（QQ 只下发 ID）", () => {
  // 真机抓包：ext 解出 {"text":""}
  const raw = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">';
  assert.equal(
    decodeFaceTags(raw),
    "[大表情 faceType=6 faceId=0（QQ 只下发 ID，不下发图片）]",
  );
});

test("decodeFaceTags: 小黄脸名字缺失时退到 faceId；坏 base64 不抛", () => {
  assert.equal(decodeFaceTags('<faceType=1,faceId="7">'), "[小黄脸表情#7]");
  assert.ok(decodeFaceTags('<faceType=2,faceId="9",ext="%%%">').includes("faceType=2"));
});

test("collectAttachments: 顶层 + msg_elements 归一去重", () => {
  const msg = {
    attachments: [{ content_type: "IMAGE/GIF", url: "http://x/a.gif", filename: "a.gif", width: 240, height: 240, size: 12345 }],
    msgElements: [
      { msg_idx: "1", attachments: [{ content_type: "image/gif", url: "http://x/a.gif", filename: "a.gif" }] },
      { msg_idx: "2", attachments: [{ content_type: "image/png" }] }, // 无 url 保留（描述用）
    ],
  };
  const atts = collectAttachments(msg);
  assert.equal(atts.length, 2);
  assert.equal(atts[0].contentType, "image/gif");
  assert.equal(atts[0].width, 240);
  assert.equal(atts[1].url, undefined);
  assert.deepEqual(collectAttachments({}), []);
  assert.deepEqual(collectAttachments(null), []);
});

test("collectAttachments: 超 MAX_ATTACHMENTS 截断", () => {
  const msg = { attachments: Array.from({ length: 9 }, (_, i) => ({ content_type: "image/png", url: `http://x/${i}.png` })) };
  assert.equal(collectAttachments(msg).length, MAX_ATTACHMENTS);
});

test("describeAttachment: 类型/尺寸/大小", () => {
  assert.equal(describeAttachment({ contentType: "image/gif", width: 240, height: 240, size: 126976 }), "image/gif 240×240 124.0KB");
  assert.equal(describeAttachment({ contentType: "video/mp4" }), "video/mp4");
});

test("downloadAttachment: 下载落盘 + 扩展名识别 + 媒体目录 env", () => {
  return (async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex"); // PNG 魔数头
    const server = http.createServer((req, res) => {
      if (req.url?.includes("404")) {
        res.statusCode = 404;
        res.end("nope");
        return;
      }
      res.setHeader("content-type", "image/png");
      res.end(png);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "qqbot-media-"));
    process.env.ZCODE_QQBOT_MEDIA = join(dir, "media");
    try {
      assert.equal(mediaDir(), process.env.ZCODE_QQBOT_MEDIA);
      const r = await downloadAttachment(
        { contentType: "image/png", url: `http://127.0.0.1:${port}/x.png`, filename: "表情.png" },
      );
      assert.ok(r.ok, `下载应成功：${r.ok ? "" : r.error}`);
      if (r.ok) {
        assert.ok(r.path.endsWith(".png"), `扩展名应来自文件名：${r.path}`);
        assert.equal(statSync(r.path).size, png.length);
        assert.deepEqual(readFileSync(r.path), png);
        assert.ok(r.path.startsWith(join(dir, "media")));
      }
      // 非白名单扩展名从 content_type 推断；无 url / HTTP 错误给出可读原因
      const noUrl = await downloadAttachment({ contentType: "image/png" });
      assert.ok(!noUrl.ok);
      const bad = await downloadAttachment({ contentType: "image/jpeg", url: `http://127.0.0.1:${port}/404` });
      assert.ok(!bad.ok && bad.error.includes("404"), `HTTP 错误应可读：${bad.ok ? "" : bad.error}`);
    } finally {
      delete process.env.ZCODE_QQBOT_MEDIA;
      server.close();
    }
  })();
});
