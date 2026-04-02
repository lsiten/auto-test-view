import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", ".auto-test-view/tests/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
