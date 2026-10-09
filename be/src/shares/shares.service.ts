import {
  BadRequestException, ConflictException, GoneException, HttpException, Injectable, Logger, NotFoundException,
  PayloadTooLargeException, ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { DEFAULT_SHARE_DURATION_DAYS, SHARE_CONSENT_VERSION, UI_LANGUAGES, isShareDurationDays, type ShareDurationDays } from '@damwha/contracts';
import { encryptShare, generateShareKey, newDeleteToken, newShareId, type ShareScope } from '@damwha/share-format';
import { DatabaseService } from '../database/database.service';
import { ShareClient, ShareServiceError, ShareTooLargeError } from './share-client';
import { buildPayload, SummaryNotReadyError } from './share-payload';
import { readSnapshot } from './share-snapshot';
import { ShareInProgressError, SharesRepository, type ListedShareRow, type ShareRow, type ShareStatus } from './shares.repository';

const MEETING_ID_RE = /^mtg_[1-9][0-9]*$/;
const DAY_MS = 86_400_000;

const ScopeSchema = z.object({
  summary: z.boolean(), lenses: z.boolean(), transcript: z.boolean(), note: z.boolean(), anonymize: z.boolean(),
}).strict();
const PreviewSchema = z.object({
  scope: ScopeSchema,
  ui_language: z.enum(UI_LANGUAGES),
  duration_days: z.number().refine((v): v is ShareDurationDays => isShareDurationDays(v)).optional(),
}).strict();
const CreateSchema = z.object({
  scope: ScopeSchema,
  ui_language: z.enum(UI_LANGUAGES),
  duration_days: z.number().refine((v): v is ShareDurationDays => isShareDurationDays(v)),
  consent_version: z.number().int(),
  transcript_ack: z.boolean().optional(),
}).strict();

export type ShareView = {
  id: string;
  meeting_id: string | null;
  status: ShareStatus;
  url: string | null;
  expires_at: string | null;
  scope: ShareScope;
  duration_days: number;
  created_at: string;
};
export type ListedShare = ShareView & { meeting_title: string | null };
export type RevokeSummary = { share_revoke: 'none' | 'revoked' | 'pending'; share_expires_at: string | null };

const bad = (code: string, message: string) => new BadRequestException({ statusCode: 400, code, message });

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw bad('BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '));
  return r.data;
}

/** 내부 오류 → HTTP. 화면은 code로 문구를 고른다. */
function toHttp(e: unknown): unknown {
  if (e instanceof ShareInProgressError) return new ConflictException({ statusCode: 409, code: 'SHARE_IN_PROGRESS', message: e.message });
  if (e instanceof SummaryNotReadyError) return bad('SUMMARY_NOT_READY', e.message);
  if (e instanceof ShareTooLargeError) return new PayloadTooLargeException({ statusCode: 413, code: 'SHARE_TOO_LARGE', message: e.message });
  if (e instanceof ShareServiceError) {
    if (e.kind === 'unreachable') {
      return new HttpException({ statusCode: 502, code: 'SHARE_SERVICE_UNREACHABLE', message: 'the share service is unreachable' }, 502);
    }
    if (e.status === 413) return new PayloadTooLargeException({ statusCode: 413, code: 'SHARE_TOO_LARGE', message: 'the share service refused the size' });
    if (e.status === 503 || e.status === 429) {
      return new ServiceUnavailableException({ statusCode: 503, code: 'SHARE_SERVICE_BUSY', message: 'the share service is not accepting uploads right now' });
    }
    return new HttpException({ statusCode: 502, code: 'SHARE_SERVICE_REJECTED', message: `the share service answered ${e.status}` }, 502);
  }
  return e;
}

@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);
  private retrying: Promise<void> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: SharesRepository,
    private readonly client: ShareClient,
  ) {}

  toView(row: ShareRow): ShareView {
    return {
      id: row.id,
      meeting_id: row.meeting_id,
      status: row.status,
      url: row.status === 'active' && row.remote_id && row.share_key ? this.client.linkFor(row.remote_id, row.share_key) : null,
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      scope: row.scope,
      duration_days: row.duration_days,
      created_at: row.created_at.toISOString(),
    };
  }

  private assertMeetingId(meetingId: string) {
    if (!MEETING_ID_RE.test(meetingId)) throw new NotFoundException('meeting not found');
  }

  async preview(meetingId: string, body: unknown) {
    this.assertMeetingId(meetingId);
    const req = parse(PreviewSchema, body);
    const snap = await readSnapshot(this.db.pool, meetingId);
    if (!snap) throw new NotFoundException('meeting not found');
    const now = new Date();
    const days: ShareDurationDays = req.duration_days ?? DEFAULT_SHARE_DURATION_DAYS;
    try {
      return {
        payload: buildPayload(snap, req.scope, { now, uiLanguage: req.ui_language }),
        expires_at_estimate: new Date(now.getTime() + days * DAY_MS).toISOString(),
      };
    } catch (e) {
      throw toHttp(e);
    }
  }

  async create(meetingId: string, body: unknown): Promise<{ share: ShareView }> {
    this.assertMeetingId(meetingId);
    const req = parse(CreateSchema, body);
    const { scope } = req;
    if (!scope.summary && !scope.lenses && !scope.transcript && !scope.note) {
      throw bad('EMPTY_SCOPE', 'choose at least one of summary, lenses, transcript, note');
    }
    if (req.consent_version !== SHARE_CONSENT_VERSION || (scope.transcript && req.transcript_ack !== true)) {
      throw bad('CONSENT_REQUIRED', 'the current consent (and the transcript acknowledgement) is required');
    }

    // 1. 예약 — 같은 회의의 creating은 하나뿐이다(유니크 인덱스). 두 번째 요청은 409.
    //    공유 id·삭제 토큰은 여기서 만들어 **업로드 전에** 저장한다(spec selfhost-v2 §2.7).
    const remoteId = newShareId(req.duration_days);
    const deleteToken = newDeleteToken();
    let shareId: string;
    try {
      shareId = await this.db.withTransaction(async (c) => {
        if (!(await this.repo.lockMeeting(c, meetingId))) throw new NotFoundException('meeting not found');
        return this.repo.insertCreating(c, {
          meetingId, scope, durationDays: req.duration_days, consentVersion: req.consent_version, remoteId, deleteToken,
        });
      });
    } catch (e) {
      throw toHttp(e);
    }

    // 업로드가 서버에 객체를 남겼을 수 있는가. 그렇다면 예약 행(=삭제 토큰)을 지우면 안 된다 — 철회로 끝낸다.
    let mayExistRemotely = false;
    try {
      // 2. 스냅샷 — 한 시점. 3. 암호화·업로드 — 트랜잭션 밖.
      const snap = await readSnapshot(this.db.pool, meetingId);
      if (!snap) throw new GoneException({ statusCode: 410, code: 'MEETING_DELETED', message: 'the meeting was deleted' });
      const key = generateShareKey();
      const payload = buildPayload(snap, scope, { now: new Date(), uiLanguage: req.ui_language });
      // 교체 — 기존 active의 원격 id·삭제 토큰을 업로드 요청에 싣는다. 서버가 같은 요청에서 지우므로 응답이 오면
      // 기존 링크는 이미 막혀 있다(spec selfhost-v2 §2.4). 토큰이 틀리면 서버는 아무것도 만들지 않는다(403).
      const current = await this.repo.findActive(this.db.pool, meetingId);
      const replace = current?.remote_id && current.delete_token ? { id: current.remote_id, token: current.delete_token } : undefined;
      const envelope = await encryptShare(payload, key);
      let up: { expires_at: string; replaced: boolean };
      try {
        up = await this.client.upload(envelope, { id: remoteId, deleteToken, days: req.duration_days, replace });
      } catch (e) {
        // 서버가 분명히 만들지 않았으면(4xx·크기 초과, 또는 요청이 나가지도 못함 — 이름 풀이 실패·연결 거절, Tunnel
        // 연결 전이 그렇다) 아래 catch가 예약 행을 지운다. 모르면(끊김·타임아웃·5xx) 객체가 생겼을 수 있으니 철회
        // 대기열로 — 실패는 "닫히는 쪽"이다.
        if (e instanceof ShareServiceError && !e.definitelyNotCreated) {
          mayExistRemotely = true;
          const row = await this.repo.creatingToRevokePending(this.db.pool, shareId);
          if (row) this.revokeInBackground([row]);
        }
        throw e;
      }
      mayExistRemotely = true;

      // 4. 확정 — 기존 active를 먼저 내려야 active 유니크 인덱스와 부딪히지 않는다. 업로드하는 사이 사용자가 기존
      //    링크를 중지했다면 그 행은 이미 active가 아니라 여기서 잡히지 않고, 새 링크는 그대로 활성화된다(spec §2.7 6).
      const confirm = this.db.withTransaction(async (c) => {
        if (!(await this.repo.lockMeeting(c, meetingId))) {
          const orphan = await this.repo.creatingToRevokePending(c, shareId, up.expires_at);
          return { gone: true as const, toRevoke: orphan ? [orphan] : [] };
        }
        const old = await this.repo.markActiveRevokePending(c, meetingId);
        // 서버가 교체로 지운 행은 바로 revoked. 서버가 몰랐던 행(다른 주소 등)만 철회 대기열에 남긴다.
        const toRevoke: ShareRow[] = [];
        for (const row of old) {
          if (up.replaced && row.remote_id === replace?.id) await this.repo.markRevoked(c, row.id);
          else toRevoke.push(row);
        }
        await this.repo.activate(c, shareId, { key, expiresAt: up.expires_at });
        return { gone: false as const, toRevoke };
      });
      const outcome = await confirm.catch(async (e: unknown) => {
        // 확정이 실패했다(롤백) — 서버에는 객체가 있고 링크는 내보내지 않았다. 철회 대기열로 보낸다. 이것마저
        // 실패하면 행은 creating으로 남고 스위퍼가 10분 뒤 revoke_pending으로 바꾼다.
        const row = await this.repo.creatingToRevokePending(this.db.pool, shareId, up.expires_at).catch(() => null);
        if (row) this.revokeInBackground([row]);
        throw e;
      });
      // 5. 남은 철회는 응답을 기다리지 않는다(보통 비어 있다).
      this.revokeInBackground(outcome.toRevoke);
      if (outcome.gone) throw new GoneException({ statusCode: 410, code: 'MEETING_DELETED', message: 'the meeting was deleted while sharing' });
      return { share: this.toView((await this.repo.findById(this.db.pool, shareId))!) };
    } catch (e) {
      // 서버가 분명히 만들지 않은 경우만 예약을 지운다. 아니면 위에서 철회 대기열로 보냈다(또는 스위퍼가 보낸다).
      if (!mayExistRemotely) await this.repo.deleteIfCreating(this.db.pool, shareId).catch(() => undefined);
      throw toHttp(e);
    }
  }

  async get(meetingId: string): Promise<{ share: ShareView | null }> {
    this.assertMeetingId(meetingId);
    const row = await this.repo.findCurrent(this.db.pool, meetingId);
    return { share: row ? this.toView(row) : null };
  }

  async stop(meetingId: string): Promise<{ share: ShareView; pending: boolean }> {
    this.assertMeetingId(meetingId);
    // 회의 잠금 먼저 — 진행 중인 확정이 있으면 끝나기를 기다렸다가 그 새 active를 내린다(안 잠그면 내릴 행을
    // 못 보고 404가 된다).
    const rows = await this.db.withTransaction(async (c) => {
      await this.repo.lockMeeting(c, meetingId);
      return this.repo.markActiveRevokePending(c, meetingId);
    });
    if (rows.length === 0) throw new NotFoundException({ statusCode: 404, code: 'NO_ACTIVE_SHARE', message: 'no active share for this meeting' });
    const row = await this.tryRevoke(rows[0]);
    return { share: this.toView(row), pending: row.status === 'revoke_pending' };
  }

  async list(): Promise<{ shares: ListedShare[] }> {
    const rows = await this.repo.listVisible(this.db.pool);
    return { shares: rows.map((r: ListedShareRow) => ({ ...this.toView(r), meeting_title: r.meeting_title })) };
  }

  /** 철회를 한 번씩 시도한다. 회의 삭제(Task 11)가 결과를 화면에 알리려고 기다린다. */
  async revokeRows(rows: ShareRow[]): Promise<RevokeSummary> {
    if (rows.length === 0) return { share_revoke: 'none', share_expires_at: null };
    const after = await Promise.all(rows.map((r) => this.tryRevoke(r)));
    const pending = after.filter((r) => r.status === 'revoke_pending');
    if (pending.length === 0) return { share_revoke: 'revoked', share_expires_at: null };
    const latest = pending.map((r) => r.expires_at?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    return { share_revoke: 'pending', share_expires_at: latest ? new Date(latest).toISOString() : null };
  }

  /**
   * 응답을 기다리지 않는 철회. 실패해도 행은 revoke_pending으로 남아 스위퍼가 다시 시도한다. 로그에는 오류 이름과
   * 행 id만 싣는다 — 키·삭제 토큰이 어떤 경로로도 로그에 섞이지 않게.
   */
  private revokeInBackground(rows: ShareRow[]): void {
    if (rows.length === 0) return;
    this.revokeRows(rows).catch((e: unknown) => {
      this.logger.warn(`background share revoke failed (${(e as Error)?.name ?? 'unknown'}) for ${rows.map((r) => r.id).join(',')} — will retry`);
    });
  }

  /** 만료 정리 → 오래된 creating을 철회 대기로 → 때가 된 철회 재시도 (Task 11의 스위퍼가 부른다). */
  async sweep(): Promise<void> {
    try {
      await this.repo.expireDue(this.db.pool);
      await this.repo.staleCreatingToRevokePending(this.db.pool);
    } catch (e) {
      this.logger.warn(`share sweep cleanup failed (${(e as Error)?.name ?? 'unknown'})`); // 메시지는 싣지 않는다 — 값이 섞일 수 있다
    }
    await this.retryPending();
  }

  /** 겹쳐 부르면 진행 중인 한 번을 같이 기다린다. */
  retryPending(): Promise<void> {
    this.retrying ??= (async () => {
      try {
        for (const row of await this.repo.listRevokeDue(this.db.pool)) await this.tryRevoke(row);
      } catch (e) {
        this.logger.warn(`share revoke retry failed (${(e as Error)?.name ?? 'unknown'})`);
      }
    })().finally(() => {
      this.retrying = null;
    });
    return this.retrying;
  }

  private async tryRevoke(row: ShareRow): Promise<ShareRow> {
    if (!row.remote_id || !row.delete_token) return this.repo.markRevoked(this.db.pool, row.id);
    try {
      await this.client.remove(row.remote_id, row.delete_token);
      return await this.repo.markRevoked(this.db.pool, row.id);
    } catch (e) {
      const err = e instanceof ShareServiceError ? { kind: e.kind, status: e.status } : { kind: 'unknown', status: null };
      this.logger.warn(`share ${row.id} revoke failed (${err.kind}${err.status ? ` ${err.status}` : ''}) — will retry`);
      return this.repo.recordRevokeFailure(this.db.pool, row.id, err);
    }
  }
}
