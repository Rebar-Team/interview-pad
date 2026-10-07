import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 900, height: 600 },
  },
  webServer: [
    { command: "cargo run --locked", port: 3030, timeout: 120000 },
    { command: "npm run dev -- --host 127.0.0.1", port: 5173 },
  ],
});
