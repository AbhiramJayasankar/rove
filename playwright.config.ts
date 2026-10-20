import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 90000,
  use: { baseURL: "http://127.0.0.1:4799", trace: "retain-on-failure" },
  webServer: {
    command: "npx tsx server/index.ts --dev",
    url: "http://127.0.0.1:4799/api/health",
    reuseExistingServer: false,
    timeout: 60000,
    env: { RELAY_DATA_DIR: `.relay-test/${Date.now()}`, RELAY_PORT: "4799" },
  },
});
