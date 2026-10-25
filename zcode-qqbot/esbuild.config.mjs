import { build } from "esbuild";

// dist/ 产物随插件安装、运行时零 node_modules：所有运行时依赖必须 bundle 进单文件。
// 三个入口：MCP 服务器（含网关+控制平面）、Stop 钩子、UserPromptSubmit 钩子。
const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: false,
  logLevel: "info",
  // CJS 依赖的运行期 require（如 qrcode/lib/renderer/png.js 顶层的 require("fs")，
  // 因包在 __commonJS 惰性闭包里无法提升为静态 import）会落到 esbuild 的 __require
  // 垫片，ESM 下没有原生 require 直接抛 "Dynamic require of ... is not supported"。
  // 注入 createRequire 版 require 让垫片的 typeof require 分支生效。
  banner: {
    js: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);`,
  },
};

await build({
  ...common,
  entryPoints: ["src/mcp-server.ts"],
  outfile: "dist/mcp-server.mjs",
});

await build({
  ...common,
  entryPoints: ["src/hook-stop.mts"],
  outfile: "dist/hook-stop.mjs",
});

await build({
  ...common,
  entryPoints: ["src/hook-user-prompt-submit.mts"],
  outfile: "dist/hook-user-prompt-submit.mjs",
});
