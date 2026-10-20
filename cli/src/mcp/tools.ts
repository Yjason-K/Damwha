import { isAbsolute } from 'node:path';
import { DEVICES, PRESET_NAMES, STT_LANGUAGES, WHISPER_MODELS } from '@damwha/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { LensItem, LensQuery } from '../api-types';
import type { DamwhaClient } from '../client';
import { resolveMeSpeakerId } from '../commands/lenses';
import type { ConnectionResult } from '../connection';
import { ApiRequestError, FileNotReadableError, NotConnectedError, UsageError } from '../errors';
import { msg, type Lang } from '../messages';
import { buildUploadForm, parseUploadOptions, resolveFolderId } from '../upload-options';
import { UNTRUSTED_NOTICE, plainForPrompt, stripControl, untrusted } from './untrusted';

export interface McpDeps {
  connect(): Promise<ConnectionResult>;
  makeClient(baseUrl: string): DamwhaClient;
  lang(): Promise<Lang>;
  stat(p: string): Promise<{ mtime: Date } | null>;
  /** 확인 창 응답 대기 시간. 테스트에서만 줄인다. */
  elicitTimeoutMs?: number;
}

/** 도구 안에서 던진 오류를 isError 결과로 바꿀 때 쓴다. */
class ToolFailure extends Error {}

const ok = (body: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const note = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * 도구 호출마다 연결을 다시 확인한다 — 앱은 서버가 살아 있는 동안 켜지고 꺼질 수 있다 (spec §2.5).
 * 연결 실패와 API 오류는 프로토콜 오류가 아니라 도구 오류(isError)로 돌려 에이전트가 읽게 한다.
 */
export async function runTool(
  deps: McpDeps,
  fn: (client: DamwhaClient, lang: Lang) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const lang = await deps.lang();
  try {
    const conn = await deps.connect();
    if (conn.kind !== 'ok') return fail(msg(lang, conn.kind === 'starting' ? 'starting' : 'notRunning'));
    return await fn(deps.makeClient(conn.baseUrl), lang);
  } catch (e) {
    if (e instanceof ToolFailure || e instanceof ApiRequestError) return fail(e.message);
    if (e instanceof NotConnectedError) return fail(msg(lang, e.kind === 'starting' ? 'starting' : 'notRunning'));
    if (e instanceof FileNotReadableError) return fail(msg(lang, 'fileNotReadable', { path: e.path }));
    if (e instanceof UsageError) {
      return fail(
        e.option && e.allowed
          ? msg(lang, 'invalidOption', { option: e.option, allowed: e.allowed.join(', ') })
          : e.message,
      );
    }
    if (e instanceof SyntaxError) return fail(msg(lang, 'badResponse'));
    const reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
    return fail(msg(lang, 'requestFailed', { reason: reason.split('\n')[0] }));
  }
}

const describe = (text: string) => `${text} ${UNTRUSTED_NOTICE}`;

/** 서버가 만든 값만 통과시키는 회의 필드. 나머지(제목·요약·태그·화자·폴더 이름 …)는 전부 untrusted로 간다. */
const MEETING_META = ['id', 'recorded_at', 'status', 'duration_ms', 'folder_id', 'is_favorite', 'processing_version', 'created_at', 'updated_at'];

function splitMeeting(m: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) (MEETING_META.includes(k) ? meta : rest)[k] = v;
  return { ...meta, ...untrusted(rest) };
}

function lensView(l: LensItem, withEvidence: boolean): Record<string, unknown> {
  return {
    id: l.id,
    kind: l.kind,
    completion_status: l.completion_status,
    lifecycle_status: l.lifecycle_status,
    confidence: l.confidence,
    meeting_id: l.meeting_id,
    assignee_speaker_id: l.assignee_speaker_id,
    due_at: l.due_at,
    created_at: l.created_at,
    updated_at: l.updated_at,
    meeting_recorded_at: l.meeting.recorded_at,
    ...untrusted({
      text: l.text,
      meeting_title: l.meeting.title,
      ...(withEvidence && {
        evidence: l.evidence.map((e) => ({
          relation: e.relation,
          utterance_id: e.utterance.id,
          start_ms: e.utterance.start_ms,
          speaker_id: e.utterance.speaker_id,
          text: e.utterance.text,
        })),
      }),
    }),
  };
}

/**
 * 상태 응답에는 워커가 쓴 오류 문장(error, capture_error …)이 섞여 있고 거기에 전사·LLM 출력이 들어갈 수 있다.
 * 열거형·식별자·시각만 최상위에 남기고 나머지 문자열은 같은 경로로 untrusted 쪽에 옮긴다.
 */
const SAFE_STRING_KEY = /^(id|meeting_id|current_job_id|status|stage|state|model|meeting_status|.*_at)$/;

function splitStatus(v: unknown, key = '', inStages = false): { safe?: unknown; taint?: unknown } {
  // stages.{process,summary,lens}는 toStages가 만든 상태 열거형이다. 모양이 enum일 때만 신뢰한다.
  if (typeof v === 'string') {
    const safe = inStages ? /^[a-z_]{1,20}$/.test(v) : SAFE_STRING_KEY.test(key);
    return safe ? { safe: stripControl(v) } : { taint: v };
  }
  if (Array.isArray(v)) {
    const parts = v.map((x) => splitStatus(x, key, inStages));
    const taint = parts.map((p) => p.taint ?? null);
    return { safe: parts.map((p) => p.safe ?? null), ...(taint.some((t) => t !== null) && { taint }) };
  }
  if (v && typeof v === 'object') {
    const safe: Record<string, unknown> = {};
    const taint: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const p = splitStatus(x, k, inStages || k === 'stages');
      if ('safe' in p) safe[k] = p.safe;
      if ('taint' in p) taint[k] = p.taint;
    }
    return { safe, ...(Object.keys(taint).length && { taint }) };
  }
  return { safe: v };
}

const drop = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** MCP 입력은 snake_case(`stt_device`)로 받고 parseUploadOptions가 읽는 camelCase로 옮긴다. */
const camel = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

export function registerReadTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'list_lenses',
    {
      description: describe(
        'List extracted meeting lenses (action items, decisions, promises), newest first. ' +
          'due_from/due_to filter on the due date (due_at), not the meeting date. ' +
          'mine=true limits to items assigned to the user (requires a speaker marked "Me" in Damwha).',
      ),
      inputSchema: {
        kind: z.string().optional().describe('Lens kind, e.g. action, decision, promise'),
        meeting_id: z.string().optional(),
        folder_id: z.string().optional(),
        due_from: z.string().optional().describe('ISO date; due date lower bound'),
        due_to: z.string().optional().describe('ISO date; due date upper bound'),
        completion_status: z.enum(['open', 'done']).optional(),
        mine: z.boolean().optional().describe('Only items assigned to the user'),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional().describe('next_cursor from a previous page'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(deps, async (client, lang) => {
        const { mine, ...rest } = args;
        const q: LensQuery = drop(rest);
        if (mine) {
          // is_me 화자가 없으면 빈 목록 대신 오류다 — 빈 목록은 "내 작업 없음"으로 잘못 읽힌다 (spec §2.4).
          const me = await resolveMeSpeakerId(client);
          if (!me) return fail(msg(lang, 'noMeSpeaker'));
          q.speaker_id = me;
        }
        const page = await client.listLenses(q);
        return ok({ total: page.total, next_cursor: page.next_cursor, items: page.items.map((l) => lensView(l, false)) });
      }),
  );

  server.registerTool(
    'get_lens',
    {
      description: describe('Get one lens with its meeting title and the supporting utterances (evidence).'),
      inputSchema: { lens_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ lens_id }) => runTool(deps, async (client) => ok(lensView(await client.getLens(lens_id), true))),
  );

  server.registerTool(
    'list_meetings',
    {
      description: describe('List meetings, newest recording first: id, recording time, status, folder, and title.'),
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional().describe('next_cursor from a previous page'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ limit, cursor }) =>
      runTool(deps, async (client) => {
        // 쿼리를 안 주면 be가 옛 배열 응답을 주므로 limit을 항상 보낸다.
        const page = await client.listMeetings(drop({ limit: limit ?? 50, cursor }));
        return ok({
          next_cursor: page.next_cursor,
          items: page.items.map((m) => {
            const { summary: _s, tags: _t, speakers: _p, utterances: _u, ...slim } = m as Record<string, unknown>;
            return splitMeeting(slim);
          }),
        });
      }),
  );

  server.registerTool(
    'get_meeting',
    {
      description: describe(
        'Get a meeting: summary (topics, segments), tags and speakers. Utterances are not included, only utterance_count; use get_transcript for them.',
      ),
      inputSchema: { meeting_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ meeting_id }) =>
      runTool(deps, async (client) => {
        const { utterances, ...m } = (await client.getMeeting(meeting_id)) as Record<string, unknown>;
        return ok({ ...splitMeeting(m), utterance_count: Array.isArray(utterances) ? utterances.length : 0 });
      }),
  );

  server.registerTool(
    'get_transcript',
    {
      description: describe('Get a page of a meeting transcript. Page with next_offset until it is null.'),
      inputSchema: {
        meeting_id: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 200, max 500'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ meeting_id, offset, limit }) =>
      runTool(deps, async (client) => {
        const t = await client.getTranscript(meeting_id, drop({ offset, limit }));
        return ok({
          meeting_id: t.meeting_id,
          total: t.total,
          offset: t.offset,
          next_offset: t.next_offset,
          utterances: t.utterances.map((u) => ({
            id: u.id,
            start_ms: u.start_ms,
            end_ms: u.end_ms,
            speaker_id: u.speaker_id,
            ...untrusted({ text: u.text, speaker_name: u.speaker_name }),
          })),
        });
      }),
  );

  server.registerTool(
    'search',
    {
      description: describe('Search meeting utterances. Returns excerpts with meeting id, utterance id and timestamps.'),
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        meeting_id: z.string().optional(),
        folder_id: z.string().optional(),
        date_from: z.string().optional().describe('ISO date; recording date lower bound'),
        date_to: z.string().optional().describe('ISO date; recording date upper bound'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit, meeting_id, folder_id, date_from, date_to }) =>
      runTool(deps, async (client) => {
        const filters = drop({
          dateFrom: date_from,
          dateTo: date_to,
          meetingIds: meeting_id ? [meeting_id] : undefined,
          folderIds: folder_id ? [folder_id] : undefined,
        });
        const res = await client.search(drop({ q: query, limit, filters: Object.keys(filters).length ? filters : undefined }));
        return ok({
          mode: res.mode,
          has_more: res.hasMore,
          results: res.results.map((r) => ({
            utterance_id: r.utteranceId,
            meeting_id: r.meetingId,
            recorded_at: r.recordedAt,
            start_ms: r.startMs,
            end_ms: r.endMs,
            speaker_id: r.speaker?.id ?? null,
            score: r.score,
            ...untrusted({ text: r.text, meeting_title: r.meetingTitle, speaker_name: r.speaker?.name ?? null }),
          })),
        });
      }),
  );

  server.registerTool(
    'get_meeting_status',
    {
      description: describe('Get processing progress of a meeting (process, summary and lens stages), e.g. after upload_audio.'),
      inputSchema: { meeting_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ meeting_id }) =>
      runTool(deps, async (client) => {
        const { safe, taint } = splitStatus(await client.getStatus(meeting_id));
        return ok({ ...(safe as object), ...(taint !== undefined && untrusted(taint)) });
      }),
  );

  server.registerTool(
    'upload_audio',
    {
      description: describe(
        'Upload a local audio file as a new meeting. Returns the meeting id immediately without waiting; poll get_meeting_status for progress.',
      ),
      inputSchema: {
        path: z.string().describe('Absolute path of the audio file on this machine'),
        title: z.string().optional(),
        recorded_at: z.string().optional().describe('ISO 8601; defaults to the file modification time'),
        folder: z.string().optional().describe('Folder name or id (fld_N)'),
        preset: z.enum(PRESET_NAMES).optional(),
        whisper_model: z.enum(WHISPER_MODELS).optional(),
        stt_device: z.enum(DEVICES).optional(),
        diarization_device: z.enum(DEVICES).optional(),
        language: z.enum(STT_LANGUAGES).optional(),
        speakers: z.number().int().min(1).max(20).optional().describe('Exact speaker count'),
        min_speakers: z.number().int().min(1).max(20).optional(),
        max_speakers: z.number().int().min(1).max(20).optional(),
        no_summary: z.boolean().optional().describe('Skip summary'),
        no_lens: z.boolean().optional().describe('Skip lens extraction'),
      },
    },
    (args) =>
      runTool(deps, async (client) => {
        const { path, ...rest } = args;
        if (!isAbsolute(path)) throw new ToolFailure(`path must be absolute (got '${path}')`);
        const opts = parseUploadOptions(camel(rest));
        const st = await deps.stat(path);
        if (!st) throw new FileNotReadableError(path);
        const folderId = opts.folder ? await resolveFolderId(client, opts.folder) : undefined;
        const { id } = await client.upload(await buildUploadForm(path, opts, folderId, st.mtime));
        return ok({ meeting_id: id });
      }),
  );
}

// 사람이 대화창을 보고 답하는 시간이라 SDK 기본 요청 제한(60초)보다 길게 잡는다.
const ELICIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 완료 처리는 되돌리기 어려운 쓰기라 사용자 확인 없이는 하지 않는다 (spec C2, §2.3).
 * 확인 창은 elicitation으로만 띄울 수 있어, 이 도구는 그걸 지원하는 클라이언트에만 등록한다.
 * 창에 보이는 문장은 에이전트 인자가 아니라 API에서 다시 읽은 값으로 만든다.
 */
export function registerCompleteLens(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'complete_lens',
    {
      description: describe(
        'Mark an open lens (e.g. an action item) as completed. The user is asked to confirm in a dialog; nothing changes unless they accept.',
      ),
      inputSchema: { lens_id: z.string() },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    ({ lens_id }) =>
      runTool(deps, async (client, lang) => {
        const lens = await client.getLens(lens_id);
        if (lens.completion_status === 'done') return note(msg(lang, 'alreadyDone'));

        const assignee = lens.assignee_speaker_id
          ? await client
              .listSpeakers()
              .then((all) => all.find((s) => s.id === lens.assignee_speaker_id)?.name ?? lens.assignee_speaker_id!)
              .catch(() => lens.assignee_speaker_id!)
          : '-';
        let answer;
        try {
          answer = await server.server.elicitInput(
            {
              message: msg(lang, 'completeConfirm', {
                title: plainForPrompt(lens.meeting.title),
                text: plainForPrompt(lens.text),
                assignee: plainForPrompt(assignee),
                due: lens.due_at ? plainForPrompt(lens.due_at.slice(0, 10)) : '-',
              }),
              requestedSchema: { type: 'object', properties: {} },
            },
            { timeout: deps.elicitTimeoutMs ?? ELICIT_TIMEOUT_MS },
          );
        } catch (e) {
          // 시간 초과·전송 오류는 API 문제가 아니다. runTool의 일반 분기로 보내면 원인이 가려진다.
          const reason = e instanceof Error ? e.message : String(e);
          return fail(msg(lang, 'completeFailed', { reason: stripControl(reason.split('\n')[0]) }));
        }
        // accept 외에는 전부 미완료로 둔다. 이유는 에이전트가 읽을 수 있게 구분해 돌려준다 (spec §2.3).
        if (answer.action === 'decline') return note(msg(lang, 'completeDeclined'));
        if (answer.action !== 'accept') return note(msg(lang, 'completeCancelled'));

        const done = await client.completeLens(lens_id);
        return ok({ id: done.id, completion_status: done.completion_status });
      }),
  );
}
