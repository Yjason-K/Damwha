// 단일 CJS 번들. desktop이 이 파일 하나를 Resources/cli/로 싣는다 (spec §2.6).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/damwha.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
});
