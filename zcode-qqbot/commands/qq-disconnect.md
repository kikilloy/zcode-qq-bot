---
description: 断开 QQ 连接并释放锁
---

1. 调用 `qq_disconnect`。
2. 转述结果：连接已断开、单实例锁已释放，其他 zcode 会话现在可以 `/qq-connect` 接管。
