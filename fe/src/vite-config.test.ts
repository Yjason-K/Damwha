import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { expect, test } from "vitest";

// vitest의 jsdom 환경에서는 `new URL(상대경로, import.meta.url)`이 file:이 아닌 http://localhost를 돌려줘서
// vite.config.ts를 직접 import하면 root 계산이 깨진다. 경로는 node:path로 만들고, 로드는 Vite 자체 로더로 한다.
const configFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../vite.config.ts",
);

test("Vite는 5173에 고정된다 — 허용 Origin(ALLOWED_ORIGINS)과 desktop dev가 이 포트를 전제한다", async () => {
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    configFile,
  );
  expect(loaded?.config.server).toMatchObject({ port: 5173, strictPort: true });
});
