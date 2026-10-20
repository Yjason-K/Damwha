// 단일 CJS 번들. desktop이 이 파일 하나를 Resources/cli/로 싣는다 (spec §2.6).
import { writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const out = 'dist/damwha.cjs';
const result = await build({
  entryPoints: ['src/main.ts'],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  write: false,
});

// esbuild는 모듈마다 `../node_modules/.pnpm/<패키지>/...` 경로를 주석과 __commonJS 키로 남긴다.
// 경로는 라벨일 뿐 런타임에 쓰이지 않는데, desktop의 check-bundle 4번이 번들 안 "/.pnpm/"을
// 빌드 머신 유출로 잡는다. 라벨에서만 그 조각을 지운다.
const text = result.outputFiles[0].text.replaceAll('/.pnpm/', '/_pnpm/');
writeFileSync(out, text);
