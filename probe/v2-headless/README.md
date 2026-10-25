# v2 无头通道考古（已归档，非主线）

2026-10-25 D0 调查结论存档。方向已在用户澄清后转为主线"值守循环"（见 docs/v2-daemon.md），
本目录只保留结论速查；原始探针脚本已弃（可再生）。

## 速查

- `zcode.cjs -p` 裸跑报 "Select a model before sending a message"：CliDefaultSelection 无种子。
  `--resume` 不继承会话模型（Hic 在 resume 分支早退）。
- 修复法（已验证后回滚，需要时按下述重做）：
  1. `~/.zcode/v2/provider_config.json` 的 `config.defaultModelSelection`
     = `{providerId, modelId, options:{reasoningLevel}}`（schema 认账）；
  2. 本机 CLI 定位不到内置 provider 配置（qfs 只认 `<glm>/provider/zcode-builtin.json`
     与上跳 5 级路径，本机安装布局两者皆无）→ 把 `D:\app\zcode\resources\config\provider\zcode-builtin.json`
     复制到 `D:\app\zcode\resources\glm\provider\zcode-builtin.json`。
  两步做完 `-p` 即可用默认模型跑（当时未及最终验收即转向，重做时先验收）。
- `app-server` 子命令 = ZCode Protocol（换行 JSON，`{id,method,params}`→`{id,result}`）。
  `session/send` 参数直接收 `modelSelection`（每消息显式指定模型）。但独立 app-server 的
  Provider Registry 为空（host 模式设计：等宿主经 `provider/updateAccountConfig` 推账号配置，
  凭据不开给独立进程）→ 独立驱动死路，除非自己解密 credentials.json（enc:v1，不做）。
- `-p --json` 输出结构化结果：`{type:"result",sessionId,turnId,response,usage,projection}`。
- 会话模型选择持久化在 db.sqlite `session_entry` 表 `runtime/model_selection`。
