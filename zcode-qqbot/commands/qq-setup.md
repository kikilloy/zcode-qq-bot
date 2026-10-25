---
description: 手动填写 QQ 机器人凭据（appId/appSecret，免扫码）
argument-hint: appId appSecret
---

向用户收集凭据并写入配置（适合已能拿到 AppID/AppSecret 的用户，比扫码配对快）：

1. `$ARGUMENTS` 里已经按顺序给出两个值（appId appSecret）就直接使用；否则请用户提供 appId 和 appSecret（QQ 开放平台 q.qq.com 的机器人详情页可查）。
2. 调用 `qq_setup {appId, appSecret}` 保存。
3. 成功后转述：凭据已写入 `~/.zcode/qqbot/config.json`（权限 0600）。下一步连接（`/qq-connect`，之后新会话默认自动连接）；首次使用还需要 `/qq-bind` 绑定 QQ 号。

注意：appSecret 是敏感值，写入后不要再复述。用户没有凭据时建议改用 `/qq-pair` 扫码配对。
