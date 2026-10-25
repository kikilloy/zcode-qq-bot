# zcode-qqbot

把 QQ 私聊桥接到当前打开的 zcode 桌面会话：QQ 消息经 Stop 钩子注入会话，模型用 `qq_reply` MCP 工具回 QQ。**会话桥，非常驻机器人**（ADR-0001）。

## 状态（M1 骨架）

- ✅ MCP 服务器骨架 + `qq_ping` 冒烟工具
- ⏳ M2 移植纯逻辑 → M3 网关+控制平面 → M4 钩子 → M5 命令与技能

设计与里程碑见仓库根 [docs/design.md](../docs/design.md)（v2 值守循环的机制证据链与真机记录档仅本地保存）。

## 开发

```bash
cd zcode-qqbot
npm install
npm run build   # esbuild → dist/mcp-server.mjs（单文件，零 node_modules）
npm run smoke   # 独立冒烟：initialize / tools/list / tools/call qq_ping
```

## 安装（自用）

仓库根即本地市场根（`marketplace.json` 在上层目录）。ZCode → 插件市场 → 添加 → 添加插件市场 → 粘贴 `E:\coding\zcode-qq-bot` → 个人 → zcode-qqbot → 安装。改码后：市场源里刷新该市场 → 插件详情 → 更新（不热载）。
