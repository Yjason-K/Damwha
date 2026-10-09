/**
 * dev 렌더러의 origin. 세 곳이 같은 값을 써야 한다: 창이 여는 URL(main.ts), 권한·내비게이션 허용 목록(main.ts),
 * 그리고 API 자식의 ALLOWED_ORIGINS(services/api-process.ts — spec 2026-10-08 §3.6). fe/vite.config.ts가
 * strictPort로 이 포트에 고정한다.
 */
export const VITE_ORIGIN = "http://localhost:5173";
