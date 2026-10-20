import { access, constants, stat } from 'node:fs/promises';
import type { Ctx } from '../context';
import { FileNotReadableError } from '../errors';
import { msg } from '../messages';
import { printJson, printLine } from '../output';
import { buildUploadForm, parseUploadOptions, resolveFolderId } from '../upload-options';
import { waitForMeeting, WaitAbortedError } from '../wait';

/** commander가 camelCase로 준 값과 `--no-*`의 부정형(`summary: false`)을 parseUploadOptions 모양으로 옮긴다. */
export function toRawUploadOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const { summary, lens, wait: _wait, json: _json, ...rest } = opts;
  return { ...rest, 'no-summary': summary === false, 'no-lens': lens === false };
}

async function checkReadable(path: string): Promise<Date> {
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error('not a file');
    await access(path, constants.R_OK);
    return s.mtime;
  } catch {
    throw new FileNotReadableError(path);
  }
}

/** 전사·요약 모델이 아직 안 받아졌는지. 조회 실패는 경고를 못 낼 뿐 업로드를 막지 않는다. */
async function modelsNotReady(ctx: Ctx): Promise<boolean> {
  try {
    const { models } = await ctx.client.listModels();
    return models.some(
      (m) =>
        m.inUseFor.some((u) => u === 'stt' || u === 'summary') && (m.installed === 'no' || m.installed === 'partial'),
    );
  } catch {
    return false;
  }
}

export async function upload(ctx: Ctx, file: string, rawOpts: Record<string, unknown>): Promise<number> {
  const opts = parseUploadOptions(toRawUploadOptions(rawOpts));
  const mtime = await checkReadable(file);
  const folderId = opts.folder ? await resolveFolderId(ctx.client, opts.folder) : undefined;

  if (await modelsNotReady(ctx)) printLine(ctx.io.stderr, msg(ctx.lang, 'modelsNotReady'));

  const { id } = await ctx.client.upload(await buildUploadForm(file, opts, folderId, mtime));
  if (!rawOpts.wait) {
    if (ctx.json) printJson(ctx.io.stdout, { id });
    else printLine(ctx.io.stdout, id);
    return 0;
  }
  if (!ctx.json) printLine(ctx.io.stderr, msg(ctx.lang, 'uploaded', { id }));

  let last = '';
  try {
    const result = await waitForMeeting(ctx.client, id, {
      intervalMs: ctx.io.waitIntervalMs ?? 2000,
      signal: ctx.io.signal ?? new AbortController().signal,
      onProgress: (s) => {
        const line = Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(' · ');
        if (!ctx.json && line !== last) printLine(ctx.io.stderr, line);
        last = line;
      },
    });
    const lensCount = (await ctx.client.listLenses({ meeting_id: id, limit: 1 })).total;
    if (ctx.json) printJson(ctx.io.stdout, { id, ok: result.ok, stages: result.stages, failed: result.failed, lens_count: lensCount });
    else {
      printLine(ctx.io.stdout, id);
      printLine(ctx.io.stdout, `lenses: ${lensCount}`);
    }
    if (!result.ok) {
      printLine(ctx.io.stderr, msg(ctx.lang, 'stageFailed', { stages: result.failed.join(', '), id }));
      return 3;
    }
    return 0;
  } catch (e) {
    if (!(e instanceof WaitAbortedError)) throw e;
    printLine(ctx.io.stderr, `${msg(ctx.lang, 'waitInterrupted')} (${id})`);
    return 0;
  }
}
