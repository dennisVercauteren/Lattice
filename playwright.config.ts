import { defineConfig, devices } from "@playwright/test";

// Isolated stack: its own API port, Vite port and graph prefix, so runs never touch real data.
const API_PORT = 8788;
const WEB_PORT = 5174;
const env = { LATTICE_PORT: String(API_PORT), LATTICE_GRAPH_PREFIX: "lattice-e2e" };

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // One shared FalkorDB workspace that every test resets, so tests run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "e2e",
      testDir: "./e2e/tests",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Training material: slower, always recorded, fixed 16:10 frame for clean screenshots.
      name: "training",
      testDir: "./e2e/training",
      timeout: 120_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        video: { mode: "on", size: { width: 1440, height: 900 } },
        launchOptions: { slowMo: 250 },
      },
    },
  ],
  webServer: [
    {
      command: "node --import tsx server/index.ts",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
