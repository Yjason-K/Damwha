import type { Ctx } from '../context';
import { meetingDetailLines, meetingLine, printJson, printLine } from '../output';

export async function meetings(ctx: Ctx, opts: { limit: number; cursor?: string }): Promise<number> {
  // 쿼리가 없으면 be가 옛 배열 응답을 주므로 limit을 항상 보낸다.
  const page = await ctx.client.listMeetings(opts.cursor ? { limit: opts.limit, cursor: opts.cursor } : { limit: opts.limit });
  if (ctx.json) printJson(ctx.io.stdout, page);
  else {
    for (const m of page.items) printLine(ctx.io.stdout, meetingLine(m, ctx.lang));
    // 다음 페이지 안내는 stderr로 — stdout은 회의 줄만 남아 파이프로 넘기기 쉽다 (lenses의 개수 줄과 같다).
    if (page.next_cursor) printLine(ctx.io.stderr, `next: --cursor ${page.next_cursor}`);
  }
  return 0;
}

export async function meeting(ctx: Ctx, id: string): Promise<number> {
  const m = await ctx.client.getMeeting(id);
  if (ctx.json) printJson(ctx.io.stdout, m);
  else for (const l of meetingDetailLines(m, ctx.lang)) printLine(ctx.io.stdout, l);
  return 0;
}
