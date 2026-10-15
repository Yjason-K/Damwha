import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { ShareScope } from '@damwha/share-format';

type Exec = Pool | PoolClient;

export type ShareStatus = 'creating' | 'active' | 'revoke_pending' | 'revoked' | 'expired';

export interface ShareRow {
  id: string;
  meeting_id: string | null;
  status: ShareStatus;
  remote_id: string | null;
  share_key: string | null;
  delete_token: string | null;
  scope: ShareScope;
  duration_days: number;
  expires_at: Date | null;
  consent_version: number;
  consented_at: Date;
  created_at: Date;
  revoke_attempted_at: Date | null;
  revoke_attempts: number;
  revoke_error: unknown;
}

export interface ListedShareRow extends ShareRow {
  meeting_title: string | null;
}

export class ShareInProgressError extends Error {
  constructor() {
    super('a share for this meeting is already being created');
    this.name = 'ShareInProgressError';
  }
}

@Injectable()
export class SharesRepository {
  /** 회의 행을 잠근다. 없으면 false — 그사이 지워진 것이다. */
  async lockMeeting(exec: Exec, meetingId: string): Promise<boolean> {
    return (await exec.query('SELECT 1 FROM meeting WHERE id=$1 FOR UPDATE', [meetingId])).rowCount === 1;
  }

  /** 예약. be가 만든 공유 id·삭제 토큰을 **업로드 전에** 저장한다 — 이후 어디서 실패해도 철회할 수 있다. */
  async insertCreating(
    exec: Exec,
    a: { meetingId: string; scope: ShareScope; durationDays: number; consentVersion: number; remoteId: string; deleteToken: string },
  ): Promise<string> {
    try {
      const { rows } = await exec.query<{ id: string }>(
        `INSERT INTO meeting_share(meeting_id,status,scope,duration_days,consent_version,consented_at,remote_id,delete_token)
         VALUES($1,'creating',$2::jsonb,$3,$4,now(),$5,$6) RETURNING id`,
        [a.meetingId, JSON.stringify(a.scope), a.durationDays, a.consentVersion, a.remoteId, a.deleteToken],
      );
      return rows[0].id;
    } catch (e) {
      const pg = e as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'meeting_share_one_creating_idx') throw new ShareInProgressError();
      throw e;
    }
  }

  async findById(exec: Exec, id: string): Promise<ShareRow | null> {
    return (await exec.query<ShareRow>('SELECT * FROM meeting_share WHERE id=$1', [id])).rows[0] ?? null;
  }

  /** 회의 화면이 보여 줄 공유: active가 있으면 그것, 없으면 가장 최근 revoke_pending. 만료가 지난 행은 걸러낸다(바꾸지 않는다). */
  async findCurrent(exec: Exec, meetingId: string): Promise<ShareRow | null> {
    const { rows } = await exec.query<ShareRow>(
      `SELECT * FROM meeting_share WHERE meeting_id=$1 AND status IN ('active','revoke_pending')
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY (status='active') DESC, created_at DESC, id DESC LIMIT 1`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async findActive(exec: Exec, meetingId: string): Promise<ShareRow | null> {
    return (await exec.query<ShareRow>(`SELECT * FROM meeting_share WHERE meeting_id=$1 AND status='active'`, [meetingId])).rows[0] ?? null;
  }

  async activate(exec: Exec, id: string, a: { key: string; expiresAt: string }): Promise<void> {
    await exec.query(
      `UPDATE meeting_share SET status='active', share_key=$2, expires_at=$3 WHERE id=$1 AND status='creating'`,
      [id, a.key, a.expiresAt],
    );
  }

  /**
   * creating → revoke_pending. 업로드가 서버에 닿았는지 모르거나(응답 유실), 닿았는데 회의가 사라졌거나, 확정 전에
   * 죽은 경우다. id·토큰을 알고 있으니 철회하면 된다 — 없으면 DELETE가 404(= 성공)다. 링크는 내보낸 적이 없다.
   * 서버가 준 만료 시각이 없으면 created_at + duration_days로 둔다 — 서버가 계속 안 닿아도 스위퍼가 그때 expired로 닫는다.
   */
  async creatingToRevokePending(exec: Exec, id: string, expiresAt: string | null = null): Promise<ShareRow | null> {
    const { rows } = await exec.query<ShareRow>(
      `UPDATE meeting_share SET status='revoke_pending', share_key=NULL, expires_at=COALESCE($2::timestamptz, expires_at, created_at + duration_days * interval '1 day')
        WHERE id=$1 AND status='creating' RETURNING *`,
      [id, expiresAt],
    );
    return rows[0] ?? null;
  }

  /** 회의의 active를 철회 대기로. 키는 지금 지운다(링크가 죽었다), 삭제 토큰은 철회가 끝날 때까지 남긴다. */
  async markActiveRevokePending(exec: Exec, meetingId: string): Promise<ShareRow[]> {
    const { rows } = await exec.query<ShareRow>(
      `UPDATE meeting_share SET status='revoke_pending', share_key=NULL
        WHERE meeting_id=$1 AND status='active' RETURNING *`,
      [meetingId],
    );
    return rows;
  }

  async deleteIfCreating(exec: Exec, id: string): Promise<void> {
    await exec.query(`DELETE FROM meeting_share WHERE id=$1 AND status='creating'`, [id]);
  }

  async markRevoked(exec: Exec, id: string): Promise<ShareRow> {
    const { rows } = await exec.query<ShareRow>(
      `UPDATE meeting_share SET status='revoked', share_key=NULL, delete_token=NULL, revoke_error=NULL,
              revoke_attempted_at=now()
        WHERE id=$1 RETURNING *`,
      [id],
    );
    return rows[0];
  }

  async recordRevokeFailure(exec: Exec, id: string, error: { kind: string; status: number | null }): Promise<ShareRow> {
    const { rows } = await exec.query<ShareRow>(
      `UPDATE meeting_share SET revoke_attempted_at=now(), revoke_attempts=revoke_attempts+1, revoke_error=$2::jsonb
        WHERE id=$1 RETURNING *`,
      [id, JSON.stringify(error)],
    );
    return rows[0];
  }

  /**
   * 다시 시도할 때가 된 철회. 간격은 5분에서 두 배씩, 최대 1시간 (spec §2.7 재시도). 30초 여유를 둔다 — 스위퍼는
   * 5분마다 돌고 시도 시각은 틱보다 몇 ms 늦게 찍혀서, 여유 없이 `<= now()`로 비교하면 매번 한 틱을 건너뛰어 간격이
   * 두 배가 된다.
   */
  async listRevokeDue(exec: Exec): Promise<ShareRow[]> {
    const { rows } = await exec.query<ShareRow>(
      `SELECT * FROM meeting_share
        WHERE status='revoke_pending'
          AND (revoke_attempted_at IS NULL
               OR revoke_attempted_at + LEAST(interval '5 minutes' * power(2, GREATEST(revoke_attempts-1, 0)), interval '1 hour') <= now() + interval '30 seconds')
        ORDER BY created_at, id`,
    );
    return rows;
  }

  /** 만료된 active·revoke_pending → expired. **스위퍼만 부른다**(GET은 상태를 바꾸지 않는다). 물리 삭제는 공유 서버의 스위퍼 몫. */
  async expireDue(exec: Exec): Promise<number> {
    const { rowCount } = await exec.query(
      `UPDATE meeting_share SET status='expired', share_key=NULL, delete_token=NULL
        WHERE status IN ('active','revoke_pending') AND expires_at <= now()`,
    );
    return rowCount ?? 0;
  }

  /**
   * 10분 넘은 creating(확정 전에 프로세스가 죽었다) → revoke_pending. 업로드가 됐는지 모르지만 id·토큰을 아니까
   * 철회한다 — 서버에 주인 없는 객체가 남지 않는다 (spec selfhost-v2 §2.7 고아 정리). expires_at이 없으니 최장 기간으로 둔다.
   */
  async staleCreatingToRevokePending(exec: Exec): Promise<number> {
    const { rowCount } = await exec.query(
      `UPDATE meeting_share SET status='revoke_pending', expires_at = created_at + interval '30 days'
        WHERE status='creating' AND created_at < now() - interval '10 minutes'`,
    );
    return rowCount ?? 0;
  }

  async listVisible(exec: Exec): Promise<ListedShareRow[]> {
    const { rows } = await exec.query<ListedShareRow>(
      `SELECT ms.*, m.title AS meeting_title FROM meeting_share ms LEFT JOIN meeting m ON m.id = ms.meeting_id
        WHERE ms.status IN ('active','revoke_pending') AND (ms.expires_at IS NULL OR ms.expires_at > now())
        ORDER BY ms.created_at DESC, ms.id DESC`,
    );
    return rows;
  }
}
