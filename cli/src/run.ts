import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { stat } from 'node:fs/promises';
import pkg from '../package.json';
import type { DamwhaClient } from './client';
import { DamwhaClient as Client } from './client';
import { fetchHealth, resolveConnection, defaultConnectionDeps, defaultUserDataDir, type ConnectionResult } from './connection';
import type { Ctx, RunIo } from './context';
import { ApiRequestError, FileNotReadableError, NotConnectedError, UsageError } from './errors';
import { detectLang, msg, type Lang } from './messages';
import { createMcpServer, serveStdio } from './mcp/server';
import { lenses } from './commands/lenses';
import { meeting, meetings } from './commands/meetings';
import { search } from './commands/search';
import { status } from './commands/status';
import { transcript } from './commands/transcript';
import { upload } from './commands/upload';
import { printLine } from './output';

export type { RunIo } from './context';

const intArg = (v: string): number => {
  if (!/^\d+$/.test(v)) throw new InvalidArgumentError('must be a non-negative integer');
  return Number(v);
};

/** 실패를 한 줄 메시지와 종료 코드로 바꾼다. 스택은 절대 내보내지 않는다. */
function report(e: unknown, lang: Lang, io: RunIo): number {
  const err = (line: string) => printLine(io.stderr, line);
  if (e instanceof UsageError) {
    err(
      e.option && e.allowed
        ? msg(lang, 'invalidOption', { option: e.option, allowed: e.allowed.join(', ') })
        : e.message,
    );
    return 1;
  }
  if (e instanceof NotConnectedError) {
    err(msg(lang, e.kind === 'starting' ? 'starting' : 'notRunning'));
    return 2;
  }
  if (e instanceof FileNotReadableError) {
    err(msg(lang, 'fileNotReadable', { path: e.path }));
    return 1;
  }
  if (e instanceof ApiRequestError) {
    err(e.message);
    return 1;
  }
  if (e instanceof SyntaxError) {
    err(msg(lang, 'badResponse'));
    return 1;
  }
  const reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
  err(msg(lang, 'requestFailed', { reason: reason.split('\n')[0] }));
  return 1;
}

export async function run(argv: string[], io: RunIo): Promise<number> {
  const userDataDir = io.userDataDir ?? defaultUserDataDir();
  const lang = await detectLang(userDataDir);
  const connect: () => Promise<ConnectionResult> =
    io.connect ?? (() => resolveConnection({ ...defaultConnectionDeps(io.env), fetchHealth }));
  const createClient = io.createClient ?? ((baseUrl: string): DamwhaClient => new Client(baseUrl, fetch, io.signal));

  let code = 0;
  const state: Ctx['state'] = {};
  /** 연결을 확인하고 명령을 돌린다. 모든 실패는 report()로 모인다. */
  const act =
    (fn: (ctx: Ctx, ...args: any[]) => Promise<number>) =>
    async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command;
      const json = Boolean(cmd.optsWithGlobals().json);
      try {
        const conn = await connect();
        if (conn.kind !== 'ok') throw new NotConnectedError(conn.kind);
        const ctx: Ctx = { client: createClient(conn.baseUrl), io, lang, json, state };
        code = await fn(ctx, ...args.slice(0, -1));
      } catch (e) {
        code = report(e, lang, io);
      }
    };

  const program = new Command('damwha')
    .version(pkg.version)
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) })
    .showHelpAfterError(false);

  program
    .command('upload <file>')
    .description('Upload an audio file')
    .option('--title <title>')
    .option('--recorded-at <iso8601>', 'defaults to the file mtime')
    .option('--folder <name|fld_N>')
    .option('--preset <name>')
    .option('--whisper-model <model>')
    .option('--stt-device <device>')
    .option('--diarization-device <device>')
    .option('--language <lang>')
    .option('--speakers <n>')
    .option('--min-speakers <n>')
    .option('--max-speakers <n>')
    .option('--no-summary', 'skip summary')
    .option('--no-lens', 'skip lens extraction')
    .option('--wait', 'wait until processing finishes')
    .option('--json')
    .action(act((ctx, file: string, opts) => upload(ctx, file, opts)));

  program
    .command('search <query>')
    .option('--limit <n>', '', intArg)
    .option('--from <date>')
    .option('--to <date>')
    .option('--meeting <id>')
    .option('--folder <name|fld_N>')
    .option('--json')
    .action(act((ctx, q: string, opts) => search(ctx, q, opts)));

  program
    .command('meetings')
    .option('--limit <n>', '', intArg, 100)
    .option('--json')
    .action(act((ctx, opts) => meetings(ctx, opts)));

  program
    .command('meeting <id>')
    .option('--json')
    .action(act((ctx, id: string) => meeting(ctx, id)));

  program
    .command('lenses')
    .option('--kind <kind>')
    .option('--mine', 'only items assigned to me')
    .option('--open')
    .option('--done')
    .option('--meeting <id>')
    .option('--due-from <date>')
    .option('--due-to <date>')
    .option('--limit <n>', '', intArg)
    .option('--json')
    .action(act((ctx, opts) => lenses(ctx, opts)));

  program
    .command('transcript <id>')
    .option('--offset <n>', '', intArg)
    .option('--limit <n>', '', intArg)
    .option('--json')
    .action(act((ctx, id: string, opts) => transcript(ctx, id, opts)));

  program
    .command('status')
    .description('Diagnose the connection to the Damwha app')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      try {
        const conn = await connect();
        code = await status(io, lang, conn, conn.kind === 'ok' ? createClient(conn.baseUrl) : null, Boolean(opts.json));
      } catch (e) {
        code = report(e, lang, io);
      }
    });

  program
    .command('mcp')
    .description('Run the stdio MCP server for coding agents')
    .action(async () => {
      // stdout은 MCP 프레임 전용이다. 연결은 도구 호출마다 다시 확인하므로 앱이 아직 없어도 서버는 뜬다.
      const server = createMcpServer({
        connect,
        makeClient: createClient,
        lang: () => detectLang(userDataDir),
        stat: async (p) => stat(p).then((s) => (s.isFile() ? { mtime: s.mtime } : null), () => null),
      });
      await serveStdio(server);
    });

  // Ctrl-C는 걸린 fetch가 있어도 바로 끝내야 한다. --wait 중이면 기다리기만 멈춘 것이라 0, 그 밖에는 130.
  const interrupted = new Promise<void>((resolve) => {
    if (io.signal?.aborted) resolve();
    else io.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  try {
    await Promise.race([program.parseAsync(argv, { from: 'user' }), interrupted]);
  } catch (e) {
    if (!io.signal?.aborted) {
      if (e instanceof CommanderError) return e.exitCode;
      return report(e, lang, io);
    }
  }
  if (io.signal?.aborted) {
    if (state.waitingId === undefined) return 130;
    printLine(io.stderr, `${msg(lang, 'waitInterrupted')} (${state.waitingId})`);
    return 0;
  }
  return code;
}
