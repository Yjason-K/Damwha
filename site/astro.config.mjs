import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

// 스펙 §3.3·§6.2. 도메인을 바꿀 때는 이 site 값 하나와 Cloudflare 설정만 바뀐다(스펙 §9).
export default defineConfig({
  site: "https://damwha.0kimjae.dev",
  trailingSlash: "always",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "ko"],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    sitemap({
      i18n: { defaultLocale: "en", locales: { en: "en", ko: "ko" } },
      filter: (page) => !page.endsWith("/404/"),
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
