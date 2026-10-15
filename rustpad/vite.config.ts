import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

const backend = {
  target: "http://127.0.0.1:3030",
  changeOrigin: true,
  secure: false,
};

export default defineConfig({
  base: "/",
  build: {
    chunkSizeWarningLimit: 1000,
  },
  plugins: [wasm(), topLevelAwait(), react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    proxy: {
      "/api": { ...backend, ws: true },
      "/auth": backend,
    },
  },
});
