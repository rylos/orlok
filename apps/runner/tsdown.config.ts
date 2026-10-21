import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  platform: "node",
  // One self-contained file: the runtime image ships without node_modules.
  deps: {
    alwaysBundle: [/.*/],
  },
});
