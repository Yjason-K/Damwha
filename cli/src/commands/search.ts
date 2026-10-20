import type { SearchBody } from '../api-types';
import type { Ctx } from '../context';
import { printJson, printLine, searchLine } from '../output';
import { resolveFolderId } from '../upload-options';

export interface SearchOpts {
  limit?: number;
  from?: string;
  to?: string;
  meeting?: string;
  folder?: string;
}

export async function search(ctx: Ctx, query: string, opts: SearchOpts): Promise<number> {
  const filters: NonNullable<SearchBody['filters']> = {};
  if (opts.from) filters.dateFrom = opts.from;
  if (opts.to) filters.dateTo = opts.to;
  if (opts.meeting) filters.meetingIds = [opts.meeting];
  if (opts.folder) filters.folderIds = [await resolveFolderId(ctx.client, opts.folder)];
  const body: SearchBody = { q: query };
  if (opts.limit !== undefined) body.limit = opts.limit;
  if (Object.keys(filters).length) body.filters = filters;

  const res = await ctx.client.search(body);
  if (ctx.json) printJson(ctx.io.stdout, res);
  else for (const r of res.results) printLine(ctx.io.stdout, searchLine(r, ctx.lang));
  return 0;
}
