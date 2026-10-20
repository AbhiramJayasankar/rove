import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["extension-core/tests/*.test.ts"], testTimeout: 15000 },
});
