import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/accessibility",
  timeout: 45000,
  globalTimeout: 600000,
  workers: 2,
  retries: 0,
  expect: { timeout: 10000 },
  reporter: [
    ["github"],
    ["html", { outputFolder: "accessibility-report", open: "never" }],
  ],
  use: {
    colorScheme: "dark",
    baseURL: "http://localhost:3000",
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PLAYWRIGHT_CHANNEL,
      },
    },
  ],
  webServer: {
    command: "npm run start --workspace=frontend",
    url: "http://localhost:3000",
    timeout: 60000,
    reuseExistingServer: false,
  },
});
