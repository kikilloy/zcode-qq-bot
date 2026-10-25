---
description: 开关终端镜像（你在 zcode 输入的提示词转发到 QQ）
argument-hint: on|off
---

参数：$ARGUMENTS（on 或 off；缺省或无法识别时先问用户想开还是关）。

1. 调用 `qq_config {forwardTerminal: true}`（on）或 `{forwardTerminal: false}`（off）。
2. **开启后必须立即、显著地提醒用户**（这是定死的界面提示需求）：

   "终端镜像已开启：你在 zcode 里输入的每条提示词（斜杠命令除外）都会以『🖥 终端』前缀发到 QQ。"

3. 关闭时告知："终端镜像已关闭。"
4. 可用 `qq_status` 确认 forwardTerminal 当前值。
