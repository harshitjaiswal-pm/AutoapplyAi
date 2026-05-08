import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config for the AutoApply web app.
 *
 * Scope: pure-logic tests (no Next.js dev server, no real Redis, no real
 * Anthropic). For things that need those, use scripts/verify_console.ts
 * in autoapply-worker (real Upstash, sentinel email so it can't pollute).
 *
 * Path aliases match tsconfig.json — `@/...` resolves to `./src/...` so
 * imports in tests look identical to imports in production code.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Keep tests fast — anything hitting the network or filesystem belongs
    // in scripts/verify_*.ts, not here.
    testTimeout: 5000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
