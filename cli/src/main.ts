import { run } from './run';

// Ctrl-C는 `--wait`의 기다리기만 멈춘다. 서버 처리는 건드리지 않는다.
const ac = new AbortController();
process.on('SIGINT', () => ac.abort());

run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  now: () => new Date(),
  signal: ac.signal,
}).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
