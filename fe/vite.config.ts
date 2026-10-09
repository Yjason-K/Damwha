/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Vite derives root -> envDir/publicDir/index.html from process.cwd().
  // In the monorepo that must never drift to the repo root, so pin both.
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  // 5173 고정. be의 ALLOWED_ORIGINS와 desktop dev(VITE_ORIGIN)가 이 origin을 전제한다 — 포트가 차 있을 때
  // 다음 포트로 옮겨 가면 조용히 403이 나므로, 옮기지 말고 실패한다(spec 2026-10-08 §3.4).
  server: { port: 5173, strictPort: true },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: true,
  },
});
