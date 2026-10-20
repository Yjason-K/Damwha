import type { LensQuery } from '../api-types';
import type { Ctx } from '../context';
import { UsageError } from '../errors';
import { msg } from '../messages';
import { lensLine, printJson, printLine } from '../output';

export interface LensesOpts {
  kind?: string;
  mine?: boolean;
  open?: boolean;
  done?: boolean;
  meeting?: string;
  dueFrom?: string;
  dueTo?: string;
  limit?: number;
}

export async function lenses(ctx: Ctx, opts: LensesOpts): Promise<number> {
  if (opts.open && opts.done) throw new UsageError('--open and --done cannot be combined');
  const q: LensQuery = {};
  if (opts.kind) q.kind = opts.kind;
  if (opts.open) q.completion_status = 'open';
  if (opts.done) q.completion_status = 'done';
  if (opts.meeting) q.meeting_id = opts.meeting;
  if (opts.dueFrom) q.due_from = opts.dueFrom;
  if (opts.dueTo) q.due_to = opts.dueTo;
  if (opts.limit !== undefined) q.limit = opts.limit;

  if (opts.mine) {
    // is_me 화자가 없으면 빈 목록 대신 오류다 — 빈 목록은 "내 작업 없음"으로 잘못 읽힌다 (spec §2.4).
    const me = (await ctx.client.listSpeakers()).find((s) => s.is_me);
    if (!me) {
      printLine(ctx.io.stderr, msg(ctx.lang, 'noMeSpeaker'));
      return 1;
    }
    q.speaker_id = me.id;
  }

  const page = await ctx.client.listLenses(q);
  if (ctx.json) printJson(ctx.io.stdout, page);
  else {
    for (const l of page.items) printLine(ctx.io.stdout, lensLine(l));
    if (page.next_cursor) printLine(ctx.io.stderr, `${page.items.length}/${page.total}`);
  }
  return 0;
}
