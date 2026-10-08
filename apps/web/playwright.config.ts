import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".tools/browsers");
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  outputDir: "../../.tools/browser-results",
  reporter: "list",
  use: {
    channel: "chromium",
    baseURL:
      process.env.STOCKSHIFT_TEST_DAEMON === "1"
        ? "http://127.0.0.1:5183"
        : "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "tablet", use: { viewport: { width: 820, height: 1100 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "node scripts/web-local.mjs",
    cwd: "../..",
    url:
      process.env.STOCKSHIFT_TEST_DAEMON === "1"
        ? "http://127.0.0.1:5183"
        : "http://127.0.0.1:5173",
    reuseExistingServer: process.env.STOCKSHIFT_TEST_DAEMON !== "1",
  },
});
