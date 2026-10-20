import type { Ctx } from '../context';
import { meetingDetailLines, meetingLine, printJson, printLine } from '../output';

export async function meetings(ctx: Ctx, opts: { limit: number }): Promise<number> {
  // 쿼리가 없으면 be가 옛 배열 응답을 주므로 limit을 항상 보낸다.
  const page = await ctx.client.listMeetings({ limit: opts.limit });
  if (ctx.json) printJson(ctx.io.stdout, page);
  else for (const m of page.items) printLine(ctx.io.stdout, meetingLine(m, ctx.lang));
  return 0;
}

export async function meeting(ctx: Ctx, id: string): Promise<number> {
  const m = await ctx.client.getMeeting(id);
  if (ctx.json) printJson(ctx.io.stdout, m);
  else for (const l of meetingDetailLines(m, ctx.lang)) printLine(ctx.io.stdout, l);
  return 0;
}
