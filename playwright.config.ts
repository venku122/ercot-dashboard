import { defineConfig, devices } from "@playwright/test";

const snapshotEnvironment = process.env.CI ? "-ubuntu-24.04" : "";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8000, toHaveScreenshot: { animations: "disabled" } },
  snapshotPathTemplate: `{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-{platform}${snapshotEnvironment}{ext}`,
  reporter: [["list"], ["html", { open: "never", outputFolder: "artifacts/playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    colorScheme: "dark",
    locale: "en-US",
    permissions: ["clipboard-read", "clipboard-write"],
    timezoneId: "America/Chicago",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /mobile.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 960 } },
    },
    {
      name: "mobile",
      grep: /@mobile-core|@responsive/,
      testMatch: /mobile.*\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "iphone-pro-max-webkit",
      grep: /@mobile-core|@responsive/,
      testMatch: /mobile.*\.spec\.ts/,
      use: {
        browserName: "webkit",
        viewport: { width: 440, height: 956 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        locale: "en-US",
        permissions: [],
        timezoneId: "America/Chicago",
        colorScheme: "dark",
      },
    },
    {
      name: "compact-mobile",
      grep: /@responsive/,
      testMatch: /mobile.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 375, height: 667 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        permissions: [],
      },
    },
    {
      name: "iphone-landscape-webkit",
      grep: /@responsive/,
      testMatch: /mobile.*\.spec\.ts/,
      use: {
        browserName: "webkit",
        viewport: { width: 956, height: 440 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        permissions: [],
      },
    },
  ],
  webServer: {
    command: "pnpm run build && pnpm run preview",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
