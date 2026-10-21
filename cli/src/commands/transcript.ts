import type { Ctx } from '../context';
import { printJson, printLine, utteranceLine } from '../output';

export async function transcript(ctx: Ctx, id: string, opts: { offset?: number; limit?: number }): Promise<number> {
  const page = await ctx.client.getTranscript(id, opts);
  if (ctx.json) printJson(ctx.io.stdout, page);
  else {
    for (const u of page.utterances) printLine(ctx.io.stdout, utteranceLine(u));
    if (page.next_offset !== null) printLine(ctx.io.stderr, `next: --offset ${page.next_offset} (total ${page.total})`);
  }
  return 0;
}
