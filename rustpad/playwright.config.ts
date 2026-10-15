import { defineConfig } from "@playwright/test";

import { BASE_URL } from "./tests/rooms";

const port = Number(new URL(BASE_URL).port);

export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL: BASE_URL,
    viewport: { width: 900, height: 600 },
  },
  webServer: [
    {
      command: "cargo run --locked",
      port: 3030,
      timeout: 120000,
      reuseExistingServer: !process.env.CI,
      env: {
        PUBLIC_ORIGIN: BASE_URL,
        SESSION_SECRET: "test-secret-at-least-32-bytes-long-xx",
        DEV_LOGIN_EMAIL: "test@withrebar.ai",
        GOOGLE_ALLOWED_DOMAIN: "withrebar.ai",
      },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
      port,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
