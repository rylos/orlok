import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/test/global-setup.ts"],
    // Integration tests share the same database.
    fileParallelism: false,
  },
});
