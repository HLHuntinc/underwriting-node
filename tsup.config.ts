import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { index: "src/index.ts", webhooks: "src/webhooks.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    target: "es2022",
    treeshake: true,
    splitting: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
  },
])
