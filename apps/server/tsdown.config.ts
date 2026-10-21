import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Loaded with `new Worker()` by src/embeddings-local, so it must be its own file in dist/.
    "embeddings-worker": "src/embeddings-local/worker.ts",
  },
  format: "esm",
  platform: "node",
  // Workspace packages ship TypeScript sources, so they must be bundled.
  deps: {
    alwaysBundle: [/^@orlok\//],
  },
});
