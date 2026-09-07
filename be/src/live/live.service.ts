import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { LiveAudioService } from '../storage/live-audio.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { JobRow, Queryable } from '../jobs/jobs.types';
import { MeetingsRepository, MeetingRow } from '../meetings/meetings.repository';
import { SettingsService } from '../settings/settings.service';
import { CapabilitiesService } from '../system/capabilities.service';
import { ProcessingOverride, ProcessingOverrideSchema, resolveProcessingConfig } from '../settings/resolve-processing';
import { SpeakerBounds, SpeakerBoundsSchema } from '../meetings/speaker-bounds';
import { buildLiveSessionPayload } from '../contracts/job-payload.schema';
import { nextId } from '../common/id';
import { LiveRepository } from './live.repository';

const RECORDING_INDEX = 'meeting_single_recording_idx';

/** 청크 하나 = 512샘플 프레임 32개 = 1.024초. 청크가 고정 크기라야 offset 산술이 정확하다. */
export const CHUNK_BYTES = 32768;
/** 오디오 재생 시간보다 캡처 경과가 이만큼 앞서면 시간이 사라진 것으로 본다. */
export const GAP_THRESHOLD_MS = 2000;
const BYTES_PER_MS = 32;
/** 누적 PCM 상한 = 16,000 Hz × 2바이트 × 4시간 (설계 §4.2). */
export const MAX_PCM_BYTES = 460800000;

/**
 * stop이 X-Capture-Error로 실어 오는 브라우저측 캡처 실패 (설계 §5.3·§7). 문구는
 * 사용자에게 보이므로 FE의 CaptureErrorNotice와 같은 코드를 쓴다.
 */
const CAPTURE_FAILURES: Record<string, string> = {
  device_ended: 'the microphone stopped before the user did',
  buffer_overflow: 'the upload backlog exceeded the buffer limit',
  upload_failed: 'the server rejected an audio chunk',
};

function isSingleRecordingViolation(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === '23505' && err?.constraint === RECORDING_INDEX;
}

/** 409로 나갈 응답. TX 안에서 예외로 표현하지 않고 값으로 들고 나온다 (설계 §3.3). */
interface LiveConflict {
  code?: 'sealed' | 'missing_chunk' | 'duration_limit';
  expected_offset: number;
}

/**
 * 디스크 쓰기·복구 실패. DB TX 실패와 반드시 구별해야 한다.
 *
 * 디스크가 나가면 이 세션은 더 쓸 수 없으므로 job과 meeting을 닫는다 (설계 §3.3 ②).
 * 반면 TX 롤백은 회복 가능한 상태다 — 파일에 남은 미확정 꼬리를 다음 요청이 truncate하고
 * 다시 쓰면 그만이다. 둘을 같이 다루면 잠깐의 DB 오류가 멀쩡한 녹음을 죽인다.
 */
class LiveDiskError extends Error {
  constructor(readonly jobId: string, readonly committed: number, cause: unknown) {
    super(String(cause));
    this.name = 'LiveDiskError';
  }
}

@Injectable()
export class LiveService {
  private readonly log = new Logger(LiveService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly liveAudio: LiveAudioService,
    private readonly jobs: JobsRepository,
    private readonly meetings: MeetingsRepository,
    private readonly live: LiveRepository,
    private readonly settings: SettingsService,
    private readonly caps: CapabilitiesService,
  ) {}

  private intHeader(v: unknown, field: string): number {
    if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new BadRequestException(`${field} must be a non-negative integer`);
    const n = Number(v);
    // "9007199254740993"은 정규식을 통과하지만 Number를 거치며 다른 값이 된다. 그 값으로
    // 오프셋 산술을 하면 경계가 조용히 어긋난다 — 헤더도 bigint와 같은 검증을 받는다 (설계 §3.2).
    if (!Number.isSafeInteger(n)) throw new BadRequestException(`${field} is out of range`);
    return n;
  }

  /** pg bigint는 문자열로 온다. 안전 정수 범위 밖이면 경계 산술이 조용히 어긋난다 (설계 §3.2). */
  private bigint(v: string | null, field: string): number {
    const n = Number(v);
    if (v === null || !Number.isSafeInteger(n)) {
      throw new HttpException({ code: 'io_error', message: `${field} is out of range` }, 500);
    }
    return n;
  }

  /**
   * 이 세션의 확정 경계.
   *
   * NULL은 024 이전에 만들어져 지금도 살아 있는 세션뿐이다. 파일 길이로 역산하지 않는다 —
   * 그러면 크래시가 남긴 미확정 꼬리를 정본으로 인정하게 되고, 이 컬럼을 도입한 이유가
   * 통째로 사라진다 (설계 §3.2). 배포 절차가 활성 녹음을 비우도록 요구하는 이유이기도 하다.
   */
  private committedOf(job: JobRow): number {
    if (job.committed_bytes === null) {
      throw new ConflictException({
        code: 'io_error',
        message: 'this live session predates the committed byte boundary',
      });
    }
    return this.bigint(job.committed_bytes, 'committed_bytes');
  }

  /** 확정 경계 뒤 미확정 꼬리를 잘라낸다. 여기서의 실패는 곧 디스크 실패다 (설계 §3.3 ①·②). */
  private async recoverOrFail(audioKey: string, committed: number, jobId: string): Promise<void> {
    try {
      await this.liveAudio.recover(audioKey, committed);
    } catch (e) {
      throw new LiveDiskError(jobId, committed, e);
    }
  }

  /**
   * 확정 경계에 완전 쓰기를 하고 같은 TX에서 그 경계를 전진시킨다 (설계 §3.3 ③·④).
   *
   * 4시간 상한을 넘는 요청은 상한까지의 prefix만 쓰고 여기서 봉인한다 (설계 §4.2) —
   * 초과분을 파일에 남기면 정본이 계약보다 길어진다. `seal`은 stop이 켠다: 꼬리 sync 뒤
   * committed와 sealed가 **하나의 TX에서** 같이 커밋돼야 한다 (설계 §3.4).
   */
  private async commitPcm(
    c: Queryable, jobId: string, audioKey: string, offset: number, pcm: Buffer, seal: boolean,
  ): Promise<{ end: number; capped: boolean }> {
    const capped = offset + pcm.length > MAX_PCM_BYTES;
    const write = capped ? pcm.subarray(0, MAX_PCM_BYTES - offset) : pcm;
    let end: number;
    try {
      end = await this.liveAudio.writeAt(audioKey, offset, write);
    } catch (e) {
      throw new LiveDiskError(jobId, offset, e);
    }
    await this.live.setCommitted(c, jobId, end);
    if (seal || capped) await this.live.seal(c, jobId, end);
    return { end, capped };
  }

  /**
   * 디스크 실패로 세션을 닫는다. 종결자는 API 하나다 (설계 §7).
   *
   * 롤백된 TX **밖의** 새 TX에서 커밋해야 한다 — 안에서 마킹하고 던지면 그 마킹 자체가
   * 같이 롤백돼 아무것도 남지 않고, 워커는 세션이 닫힌 줄 모른 채 계속 tail한다.
   *
   * 그런데 롤백이 잠금을 반납한 순간부터 이 TX가 다시 잠글 때까지는 창이다. 그 사이 정당한
   * 재전송(잃어버린 ACK)이 먼저 커밋해 경계를 전진시켜 놨을 수 있고, meeting.status는 그때도
   * 여전히 'recording'이라 그 값만으로는 구별되지 않는다. **파일 길이도 근거가 못 된다** —
   * 우리 자신의 부분 쓰기가 남긴 미확정 꼬리가 이미 그 길이를 늘려 놨다. 유일한 신호는
   * 확정 경계가 실패 전 값 그대로인가다 (설계 §3.3).
   */
  private async markDiskFailure(id: string, failure: LiveDiskError): Promise<never> {
    const err = { code: 'io_error', message: 'could not write live audio' };
    await this.db.withTransaction(async (c) => {
      const job = await this.live.lockJobById(c, failure.jobId);
      const meeting = await this.meetings.lockById(c, id);
      if (!job || !meeting) return;
      if (meeting.status !== 'recording' || meeting.current_job_id !== failure.jobId
          || job.sealed_bytes !== null) return;
      if (job.committed_bytes === null || Number(job.committed_bytes) !== failure.committed) return;
      await this.jobs.fail(c, failure.jobId, {
        ...err, kind: 'PERMANENT', stage: 'capture', message: failure.message,
      });
      await this.meetings.markFailed(c, id, err);
    });
    throw new HttpException({ code: 'io_error' }, 507);
  }

  /**
   * X-Capture-Error를 capture_error에 넣을 모양으로 바꾼다.
   *
   * 모르는 값이라고 400을 던지지 않는다 — 이 헤더는 진단이고, API는 이 세션의 종결자다
   * (설계 §7). 헤더 하나 때문에 stop이 거절되면 회의가 'recording'에 갇히고 부분 유일
   * 인덱스가 다음 녹음까지 막는다. 사유를 못 알아들어도 "캡처가 실패했다"는 사실은
   * 잃지 않도록 capture_failed로 접어 둔다.
   */
  private captureFailure(v: unknown): { code: string; message: string } | null {
    if (typeof v !== 'string' || v === '') return null;
    const known = CAPTURE_FAILURES[v];
    if (known) return { code: v, message: known };
    return { code: 'capture_failed', message: 'the browser reported an unrecognised capture failure' };
  }

  // JSON body라 multipart 문자열 파싱은 없다. 불리언은 불리언으로 받되, 업로드와의 대칭을
  // 위해 "true"/"false" 문자열도 받는다. 그 외는 400.
  private parseFlag(v: unknown, field: string): boolean {
    if (v === undefined || v === null || v === '' || v === false || v === 'false') return false;
    if (v === true || v === 'true') return true;
    throw new BadRequestException(`${field} must be a boolean`);
  }

  private parseTitle(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new BadRequestException('title must be a string');
    const t = v.trim();
    return t === '' ? null : t;
  }

  private parseOverride(v: unknown): ProcessingOverride | undefined {
    if (v === undefined) return undefined;
    const r = ProcessingOverrideSchema.safeParse(v);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
    return r.data;
  }

  private parseSpeakers(v: unknown): SpeakerBounds | undefined {
    if (v === undefined) return undefined;
    const r = SpeakerBoundsSchema.safeParse(v);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
    return r.data;
  }

  async start(body: {
    title?: unknown; processing?: unknown; speakers?: unknown; defer_lens?: unknown; defer_summary?: unknown;
  }) {
    const title = this.parseTitle(body.title);
    const override = this.parseOverride(body.processing);
    const speakers = this.parseSpeakers(body.speakers);
    const followups = {
      lens: !this.parseFlag(body.defer_lens, 'defer_lens'),
      summary: !this.parseFlag(body.defer_summary, 'defer_summary'),
    };
    const global_ = await this.settings.getProcessingConfig();
    const processing = resolveProcessingConfig(global_, override, (await this.caps.get()).gpu_eligible);

    // 친절한 메시지를 위한 사전 조회. 보장은 아래 INSERT의 부분 유일 인덱스가 한다 (설계 §4).
    if (await this.live.findRecording(this.db.pool)) {
      throw new ConflictException('a recording is already in progress');
    }
    const meetingId = await nextId(this.db.pool, 'meeting');
    const audioKey = this.storage.liveKey(meetingId);
    let meeting: MeetingRow;
    try {
      meeting = await this.db.withTransaction(async (c) => {
        await this.live.createRecording(c, { id: meetingId, audioKey, title });
        const payload = buildLiveSessionPayload({ meetingId, audioKey, processing, followups, speakers });
        // 재시도 없음 — 끊긴 녹음은 이어 붙일 수 없다 (설계 §2.6).
        const job = await this.jobs.enqueue(c, { type: 'live_session', meetingId, payload, maxAttempts: 1 });
        // 확정 경계는 파일과 함께 태어난다 — 이 TX 밖에서 만드는 live.wav가 PCM 0바이트인
        // 사실과 짝을 맞춘다. 여기서 안 하면 첫 append가 볼 committed_bytes가 NULL이라
        // "아직 시작 전"과 "확정 0바이트"를 구별할 수 없다 (설계 §3.2).
        await this.live.setCommitted(c, job.id, 0);
        return this.meetings.setCurrentJob(c, meetingId, job.id);
      });
    } catch (e) {
      if (isSingleRecordingViolation(e)) throw new ConflictException('a recording is already in progress');
      throw e;
    }

    // 트랜잭션 밖. 커밋된 뒤에 만들어야 rollback이 orphan 파일을 남기지 않는다.
    try {
      await this.liveAudio.create(audioKey);
    } catch (e) {
      // 파일을 못 만들었다. recording + queued를 남기면 회의가 갇힌다 (설계 §4.1).
      const err = { code: 'io_error', message: 'could not create the live audio file' };
      await this.db.withTransaction(async (c) => {
        const probe = await this.live.findLiveJob(c, meetingId);
        if (probe) await this.jobs.fail(c, probe.job_id, { ...err, kind: 'PERMANENT', stage: 'capture' });
        await this.meetings.markFailed(c, meetingId, err);
      });
      throw new HttpException(err, 500);
    }
    return meeting;
  }

  /**
   * 종료. 봉인과 마지막 청크 사이의 창을 없애기 위해 stop이 꼬리를 싣고 온다 (설계 §3.4).
   *
   * append와 같은 §3.3의 복구·완전 쓰기를 쓰고, 꼬리 sync 뒤 **하나의 TX에서** committed,
   * sealed, stop_requested_at을 같이 커밋한다. 그래서 갈래가 둘뿐이다.
   * - 요청 offset === 확정 경계: 꼬리를 쓰고 봉인한다. 파일에 미확정 꼬리가 붙어 있어도
   *   recover가 먼저 잘라내므로, "이미 파일에 있으니 쓰지 않는다"는 특례가 필요 없다.
   * - 그 외: `missing_chunk` 409. FE는 그 경계에서 빈 stop을 재시도한다 (설계 §7).
   *
   * sealed_bytes가 이미 있으면(이 job에 대한 재요청) 멱등 처리한다 — meeting.status/
   * current_job_id는 보지 않는다. API가 이미 finalize해 meeting이 'recording'을 벗어나고
   * current_job_id가 다음 job으로 넘어간 뒤에도, 잃어버린 200 응답의 재시도는 성공해야 한다.
   */
  async stop(id: string, headers: Record<string, unknown>, body: Buffer) {
    const offset = this.intHeader(headers['x-audio-offset'], 'X-Audio-Offset');
    const final = this.intHeader(headers['x-final-offset'], 'X-Final-Offset');
    const tail = body ?? Buffer.alloc(0);
    if (offset % 2 !== 0 || final % 2 !== 0) throw new BadRequestException('offsets must be even');
    // 자투리는 청크 하나를 못 채운 나머지다 (설계 §3.4). 그보다 크면 청크로 보냈어야 한다.
    if (tail.length >= CHUNK_BYTES) {
      throw new BadRequestException(`stop body must be smaller than ${CHUNK_BYTES} bytes`);
    }
    if (final !== offset + tail.length) {
      throw new BadRequestException('X-Final-Offset must equal X-Audio-Offset + body length');
    }

    const captureError = this.captureFailure(headers['x-capture-error']);
    // append와 달리 여기서는 형식이 틀려도 400을 내지 않는다. 거절된 청크는 클라이언트가
    // 다시 보내면 되지만 거절된 stop은 회의를 'recording'에 가둔다 — X-Capture-Error를
    // 관대하게 받는 것과 같은 이유다(설계 §7, API가 종결자). 못 읽으면 갭 판정만 건너뛴다.
    const raw = headers['x-capture-elapsed'];
    const elapsed = typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
      ? Number(raw) : null;

    let result;
    try {
      result = await this.db.withTransaction(async (c) => {
        const probe = await this.live.findLiveJob(c, id); // job → meeting 순서 (설계 §4.3)
        const job = probe ? await this.live.lockJobById(c, probe.job_id) : null;
        const meeting = await this.meetings.lockById(c, id);
        if (!meeting) throw new NotFoundException('meeting not found');
        if (!job) throw new ConflictException('meeting is not recording');

        // 봉인 판정보다 먼저 쓴다. 봉인까지 간 경로(정상·멱등 재시도)에서는 이 사실이
        // 남아야 하고, 오프셋이 안 맞아 봉인되지 않은 stop은 아직 이 세션의 마지막 말이
        // 아니므로 그 409와 함께 롤백되는 게 맞다 — 그래서 missing_chunk만 값이 아니라
        // 예외다. FE가 서버 경계에서 빈 stop을 재시도할 때 같은 헤더를 다시 실어 오므로
        // 사유를 잃지도 않는다 (설계 §7). 봉인을 커밋하고 나가는 duration_limit은 반대로
        // 값으로 들고 나가야 한다 — 던지면 그 봉인까지 롤백된다.
        if (captureError) await this.live.setCaptureError(c, id, captureError);

        // 멱등 재시도: 이 job은 이미 봉인됐다. 같은 길이면 성공, 다르면 계약 위반이다.
        if (job.sealed_bytes !== null) {
          const sealed = this.bigint(job.sealed_bytes, 'sealed_bytes');
          if (sealed !== final) {
            throw new ConflictException({ code: 'missing_chunk', expected_offset: sealed });
          }
          // 새 process job을 만들지 않는다 — 이미 만들었거나, 워커/스위퍼의 몫이다.
          // done이면 누군가 마무리를 끝냈고, 아니면 아직 마무리가 남아 있다.
          return {
            ok: {
              meeting_id: id, job_id: job.id, sealed_bytes: sealed,
              outcome: job.status === 'done' ? ('finalized' as const) : ('stopping' as const),
            },
            audioKey: meeting.audio_key, sealedBytes: sealed, discarded: false,
          };
        }
        if (meeting.status !== 'recording' || meeting.current_job_id !== job.id) {
          throw new ConflictException('meeting is not recording');
        }

        const committed = this.committedOf(job);
        await this.recoverOrFail(meeting.audio_key, committed, job.id);
        if (offset !== committed) {
          throw new ConflictException({ code: 'missing_chunk', expected_offset: committed });
        }
        const { end, capped } = await this.commitPcm(c, job.id, meeting.audio_key, offset, tail, true);

        // 설계 §3.4가 stop에도 X-Capture-Elapsed를 싣게 한 이유가 이것이다 — 꼬리 구간의
        // 불연속은 append의 갭 검사가 못 본다(그 청크는 오지 않았다). 브라우저가 이미
        // 구체적인 사유를 보냈으면 덮지 않는다: "마이크가 끊겼다"가 "시간이 비었다"보다
        // 사용자에게 훨씬 쓸모 있고, 갭은 그 사유의 결과일 뿐이다.
        if (elapsed !== null) {
          const gap = elapsed - end / BYTES_PER_MS;
          if (gap > GAP_THRESHOLD_MS) {
            await this.live.setCaptureErrorIfUnset(c, id, { code: 'capture_gap', gap_ms: Math.round(gap) });
          }
        }
        if (capped) {
          // 상한까지만 쓰고 봉인했다. finalize는 하지 않는다 — 이 stop은 계약을 벗어난
          // 요청이고, 봉인된 세션은 워커나 스위퍼가 마무리한다 (설계 §4.2).
          return { conflict: { code: 'duration_limit' as const, expected_offset: end } };
        }

        if (job.status !== 'running') {
          // 이 job을 마무리할 워커가 없다. queued면 한 번도 claim되지 않았고, failed면
          // reaper가 그 워커를 잃었다고 판정했다(설계 §2.11 — 워커를 잃어도 녹음은 살아
          // 있다). 어느 쪽이든 디스크엔 온전한 녹음이 있으므로 API가 마무리한다.
          // 원 설계의 "녹음된 게 없으니 회의를 지운다"는 파괴적으로 틀리다 (설계 §2.11).
          if (end === 0) {
            await this.meetings.deleteById(c, id);
            return {
              ok: { meeting_id: id, job_id: job.id, sealed_bytes: 0, outcome: 'discarded' as const },
              audioKey: meeting.audio_key, sealedBytes: 0, discarded: true,
            };
          }
          await this.finalizeByApi(c, job, meeting, end);
          return {
            ok: { meeting_id: id, job_id: job.id, sealed_bytes: end, outcome: 'finalized' as const },
            audioKey: meeting.audio_key, sealedBytes: end, discarded: false,
          };
        }
        return {
          ok: { meeting_id: id, job_id: job.id, sealed_bytes: end, outcome: 'stopping' as const },
          audioKey: meeting.audio_key, sealedBytes: end, discarded: false,
        };
      });
    } catch (e) {
      if (e instanceof LiveDiskError) return this.markDiskFailure(id, e);
      throw e;
    }

    // 여기서부터는 커밋된 뒤다. 응답 결정을 HTTP로 바꾼다 (설계 §3.3).
    if ('conflict' in result) throw new ConflictException(result.conflict);
    if (result.discarded) {
      await this.storage.deleteDir(this.storage.meetingDir(id));
    } else {
      // 헤더 확정은 봉인 커밋 뒤 best-effort다. 실패해도 워커는 sealed_bytes를 보고,
      // repair_streaming_header가 재처리 때 고친다 (설계 §4.4 ④).
      await this.liveAudio.seal(result.audioKey, result.sealedBytes)
        // 삼키되 흔적은 남긴다. 여기 실패에는 두 종류가 있다 — 단순 쓰기 실패(재처리 때
        // repair_streaming_header가 고친다)와, seal()이 새로 확인하는 크기 불변식 위반
        // (파일과 sealed_bytes가 어긋났다는 뜻이라 조용히 지나가면 안 된다).
        .catch((e) => this.log.error(`live header seal failed for ${id}: ${String(e)}`));
    }
    return result.ok;
  }

  /**
   * API가 finalize하는 경로. 워커의 finalize_live_session과 같은 일을 하되 job 가드가
   * status='queued'다(워커는 running AND locked_by). capture_error는 건드리지 않는다.
   */
  async finalizeByApi(c: Queryable, job: JobRow, meeting: MeetingRow, sealedBytes: number) {
    if (job.status === 'failed') {
      // reaper가 워커를 잃었다고 판정한 job이다. 아래 jobs.complete가 그 error를 덮어
      // 지우므로, "이 녹음은 라이브 미리보기 없이 얻어졌다"를 capture_error로 옮긴다
      // (설계 §7 "녹음은 계속. 미리보기만 없고"). 이미 브라우저가 더 구체적인 사유를
      // 보냈으면 덮지 않는다.
      await this.live.setCaptureErrorIfUnset(c, meeting.id, {
        code: 'preview_worker_lost',
        message: 'the live preview worker was lost; the recording itself is intact',
      });
    }
    await this.meetings.markUploaded(c, meeting.id, Math.floor(sealedBytes / BYTES_PER_MS));
    const processWire = (job.payload as { process: object }).process;
    const next = await this.jobs.enqueue(c, {
      type: 'process_meeting', meetingId: meeting.id, payload: processWire,
    });
    await this.meetings.setCurrentJob(c, meeting.id, next.id);
    await this.jobs.complete(c, job.id);
  }

  /**
   * PCM 청크를 확정 경계에 이어 붙인다.
   *
   * 오프셋의 진실은 파일 길이가 아니라 job.committed_bytes다 (설계 §3.2). 크래시는 파일에
   * 미확정 꼬리를 남길 수 있고, 파일 길이를 믿으면 그 꼬리를 정본으로 인정하게 된다.
   * 그래서 잠근 직후 recover로 경계 뒤를 잘라낸 다음에야 오프셋을 비교한다.
   *
   * 잠금은 job → meeting 순서다 (설계 §4.3). 메모리 mutex를 쓰지 않는 이유: API 재시작·
   * 두 인스턴스에서 무력하고, 그러면 append 둘이 같은 경계를 보고 둘 다 쓴다.
   * 파일 I/O 동안 DB 행 락을 잡는 대가는 의도적이다 — 초당 1회, 32 KiB다.
   *
   * 200은 커밋 뒤에만 나간다. write+fsync는 됐는데 committed 커밋 전에 죽으면 그 바이트는
   * 확정이 아니고, 클라이언트가 ACK를 받았다면 영영 다시 보내지 않을 바이트가 된다.
   */
  async appendAudio(id: string, headers: Record<string, unknown>, body: Buffer) {
    const offset = this.intHeader(headers['x-audio-offset'], 'X-Audio-Offset');
    if (offset % 2 !== 0) throw new BadRequestException('X-Audio-Offset must be even');
    if (body?.length !== CHUNK_BYTES) throw new BadRequestException(`body must be exactly ${CHUNK_BYTES} bytes`);
    const elapsed = headers['x-capture-elapsed'] === undefined
      ? null : this.intHeader(headers['x-capture-elapsed'], 'X-Capture-Elapsed');

    let decision: { conflict: LiveConflict } | { ok: { accepted_offset: number; expected_offset: number } };
    try {
      decision = await this.db.withTransaction(async (c) => {
        const probe = await this.live.findLiveJob(c, id);
        if (!probe) throw new NotFoundException('no live session for this meeting');
        const job = await this.live.lockJobById(c, probe.job_id);
        const meeting = await this.meetings.lockById(c, id);
        if (!job || !meeting || meeting.status !== 'recording' || meeting.current_job_id !== job.id) {
          throw new ConflictException('meeting is not recording');
        }
        if (job.sealed_bytes !== null) {
          return {
            conflict: {
              code: 'sealed' as const,
              expected_offset: this.bigint(job.sealed_bytes, 'sealed_bytes'),
            },
          };
        }

        const committed = this.committedOf(job);
        await this.recoverOrFail(meeting.audio_key, committed, job.id);

        if (offset + body.length === committed) {
          // 잃어버린 ACK의 재전송이다 — 이 바이트는 이미 확정됐다. 같은 producer·in-flight
          // 하나라는 전제 아래 중복으로 허용하고, 생존 시각 갱신을 **커밋한 다음** 409를
          // 낸다: 재전송하는 producer는 분명히 살아 있는데 여기서 던지면 그 갱신이 롤백돼,
          // orphan 스캐너가 멀쩡히 살아 있는 producer를 봉인한다 (설계 §3.3).
          await this.live.markInput(c, job.id);
          return { conflict: { expected_offset: committed } };
        }
        if (offset !== committed) {
          // 앞섰거나 뒤처졌다. 경계를 전진시키지 않았으므로 생존 시각도 건드리지 않는다.
          return { conflict: { expected_offset: committed } };
        }

        const { end, capped } = await this.commitPcm(c, job.id, meeting.audio_key, offset, body, false);
        if (offset === 0) await this.meetings.setRecordedAt(c, id);
        if (elapsed !== null) {
          const gap = elapsed - end / BYTES_PER_MS;
          if (gap > GAP_THRESHOLD_MS) {
            await this.live.setCaptureError(c, id, { code: 'capture_gap', gap_ms: Math.round(gap) });
          }
        }
        // 4시간 상한을 걸친 청크다. prefix는 확정·봉인됐으므로 일반 ACK가 아니다 (설계 §4.2).
        if (capped) return { conflict: { code: 'duration_limit' as const, expected_offset: end } };
        return { ok: { accepted_offset: end, expected_offset: end } };
      });
    } catch (e) {
      if (e instanceof LiveDiskError) return this.markDiskFailure(id, e);
      throw e;
    }
    // 커밋된 뒤에만 HTTP 상태로 바꾼다 (설계 §3.3).
    if ('conflict' in decision) throw new ConflictException(decision.conflict);
    return decision.ok;
  }

  async getLive(id: string, after: string | undefined) {
    let afterSeq = -1;
    if (after !== undefined) {
      if (!/^-?\d+$/.test(after)) throw new BadRequestException('after must be an integer seq');
      afterSeq = Number(after);
    }
    const head = await this.live.findHead(this.db.pool, id);
    if (!head) throw new NotFoundException('meeting not found');
    const items = await this.live.findUtterances(this.db.pool, id, afterSeq);
    return { status: head.status, stage: head.stage, heartbeat_at: head.heartbeat_at, items };
  }
}
