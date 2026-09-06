import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
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

function isSingleRecordingViolation(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === '23505' && err?.constraint === RECORDING_INDEX;
}

@Injectable()
export class LiveService {
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
    return Number(v);
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
    const audioKey = this.storage.meetingKey(meetingId, 'live.wav');
    let meeting: MeetingRow;
    try {
      meeting = await this.db.withTransaction(async (c) => {
        await this.live.createRecording(c, { id: meetingId, audioKey, title });
        const payload = buildLiveSessionPayload({ meetingId, audioKey, processing, followups, speakers });
        // 재시도 없음 — 끊긴 녹음은 이어 붙일 수 없다 (설계 §2.6).
        const job = await this.jobs.enqueue(c, { type: 'live_session', meetingId, payload, maxAttempts: 1 });
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
   * 세 경우로 갈린다 — 이것이 ③ 직전 크래시(설계 §4.4)를 복구 가능하게 만드는 규칙 전부다.
   * - expected === X-Audio-Offset: 정상. body를 append + fsync한 뒤 봉인 커밋.
   * - expected === X-Final-Offset: 꼬리가 이미 파일에 있다(③ 전 크래시 후 재시도). append
   *   없이 봉인 커밋만 재개한다 — 이 경우가 없으면 재시도가 영원히 409만 받아 세션이 봉인되지
   *   못하고, 부분 유일 인덱스가 다음 녹음을 막는다.
   * - 그 외: `missing_chunk` 409.
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
    if (final !== offset + tail.length) {
      throw new BadRequestException('X-Final-Offset must equal X-Audio-Offset + body length');
    }

    const result = await this.db.withTransaction(async (c) => {
      const probe = await this.live.findLiveJob(c, id); // job → meeting 순서 (설계 §4.3)
      const job = probe ? await this.live.lockJobById(c, probe.job_id) : null;
      const meeting = await this.meetings.lockById(c, id);
      if (!meeting) throw new NotFoundException('meeting not found');
      if (!job) throw new ConflictException('meeting is not recording');

      // 멱등 재시도: 이 job은 이미 봉인됐다. 같은 길이면 성공, 다르면 계약 위반이다.
      if (job.sealed_bytes !== null) {
        if (Number(job.sealed_bytes) !== final) {
          throw new ConflictException({ code: 'missing_chunk', expected_offset: Number(job.sealed_bytes) });
        }
        return { meeting_id: id, job_id: job.id, sealed_bytes: final, outcome: 'stopping' as const, job, meeting };
      }
      if (meeting.status !== 'recording' || meeting.current_job_id !== job.id) {
        throw new ConflictException('meeting is not recording');
      }

      const expected = await this.liveAudio.pcmSize(meeting.audio_key);
      if (expected === offset) {
        if (tail.length > 0) await this.liveAudio.append(meeting.audio_key, tail);
      } else if (expected !== final) {
        // ③ 전 크래시 후 재시도면 expected가 이미 final이다. 그 외는 결손이다.
        throw new ConflictException({ code: 'missing_chunk', expected_offset: expected });
      }
      await this.live.seal(c, job.id, final);

      if (job.status === 'queued') {
        // 워커가 한 번도 claim하지 않았다. 디스크엔 온전한 녹음이 있으므로 API가 마무리한다.
        // 원 설계의 "녹음된 게 없으니 회의를 지운다"는 파괴적으로 틀리다 (설계 §2.11).
        if (final === 0) {
          await this.meetings.deleteById(c, id);
          return { meeting_id: id, job_id: job.id, sealed_bytes: 0, outcome: 'discarded' as const, job, meeting };
        }
        await this.finalizeByApi(c, job, meeting, final);
        return { meeting_id: id, job_id: job.id, sealed_bytes: final, outcome: 'finalized' as const, job, meeting };
      }
      return { meeting_id: id, job_id: job.id, sealed_bytes: final, outcome: 'stopping' as const, job, meeting };
    });

    if (result.outcome === 'discarded') {
      await this.storage.deleteDir(this.storage.meetingDir(id));
    } else {
      // 헤더 확정은 봉인 커밋 뒤 best-effort다. 실패해도 워커는 sealed_bytes를 보고,
      // repair_streaming_header가 재처리 때 고친다 (설계 §4.4 ④).
      await this.liveAudio.seal(result.meeting.audio_key, result.sealed_bytes).catch(() => undefined);
    }
    const { job, meeting, ...body_ } = result;
    return body_;
  }

  /**
   * API가 finalize하는 경로. 워커의 finalize_live_session과 같은 일을 하되 job 가드가
   * status='queued'다(워커는 running AND locked_by). capture_error는 건드리지 않는다.
   */
  async finalizeByApi(c: Queryable, job: JobRow, meeting: MeetingRow, sealedBytes: number) {
    await this.meetings.markUploaded(c, meeting.id, sealedBytes / 32);
    const processWire = (job.payload as { process: object }).process;
    const next = await this.jobs.enqueue(c, {
      type: 'process_meeting', meetingId: meeting.id, payload: processWire,
    });
    await this.meetings.setCurrentJob(c, meeting.id, next.id);
    await this.jobs.complete(c, job.id);
  }

  /**
   * PCM 청크를 이어 붙인다.
   *
   * 잠금은 job → meeting 순서다 (설계 §4.3). 메모리 mutex를 쓰지 않는 이유: API 재시작·
   * 두 인스턴스에서 무력하고, 그러면 append 둘이 같은 expected offset을 보고 둘 다 쓴다.
   * 파일 I/O 동안 DB 행 락을 잡는 대가는 의도적이다 — 초당 1회, 32 KiB다.
   *
   * 200은 커밋 뒤에만 나간다. append+fsync는 됐는데 last_input_at 커밋 전에 죽으면 파일은
   * 전진했는데 liveness가 낡아, orphan 스캐너가 살아 있는 producer를 봉인한다.
   */
  async appendAudio(id: string, headers: Record<string, unknown>, body: Buffer) {
    const offset = this.intHeader(headers['x-audio-offset'], 'X-Audio-Offset');
    if (offset % 2 !== 0) throw new BadRequestException('X-Audio-Offset must be even');
    if (body?.length !== CHUNK_BYTES) throw new BadRequestException(`body must be exactly ${CHUNK_BYTES} bytes`);
    const elapsed = headers['x-capture-elapsed'] === undefined
      ? null : this.intHeader(headers['x-capture-elapsed'], 'X-Capture-Elapsed');

    // 트랜잭션 안에서 잡아 밖으로 들고 나올 디스크 쓰기 실패 정보. 세팅돼 있으면 그 트랜잭션은
    // 이미 롤백된 뒤이므로, 실패 마킹은 아래에서 새 트랜잭션으로 따로 커밋한다 — start()의
    // 파일 생성 실패 처리(위)와 같은 모양. io_error를 이 트랜잭션 *안에서* 마킹하고 던지면
    // 그 마킹 자체가 롤백돼 아무것도 남지 않는다 — 워커의 get_stop_requested는 job.error를
    // 보지 않으므로 세션이 아예 안 닫힌 채 계속 tail된다 (설계 §7).
    let diskFailure: { jobId: string } | null = null;

    try {
      return await this.db.withTransaction(async (c) => {
        const probe = await this.live.findLiveJob(c, id);
        if (!probe) throw new NotFoundException('no live session for this meeting');
        const job = await this.live.lockJobById(c, probe.job_id);
        const meeting = await this.meetings.lockById(c, id);
        if (!job || !meeting || meeting.status !== 'recording' || meeting.current_job_id !== job.id) {
          throw new ConflictException('meeting is not recording');
        }
        if (job.sealed_bytes !== null) throw new ConflictException({ code: 'sealed', expected_offset: Number(job.sealed_bytes) });

        const expected = await this.liveAudio.pcmSize(meeting.audio_key);
        if (expected < 0) throw new ConflictException({ code: 'io_error', message: 'live audio file is missing' });
        if (offset !== expected) throw new ConflictException({ expected_offset: expected });

        let accepted: number;
        try {
          accepted = await this.liveAudio.append(meeting.audio_key, body);
        } catch (e) {
          diskFailure = { jobId: job.id };
          throw e;
        }
        await this.live.markInput(c, job.id);
        if (offset === 0) await this.meetings.setRecordedAt(c, id);

        if (elapsed !== null) {
          const gap = elapsed - accepted / BYTES_PER_MS;
          if (gap > GAP_THRESHOLD_MS) {
            await this.live.setCaptureError(c, id, { code: 'capture_gap', gap_ms: Math.round(gap) });
          }
        }
        return { accepted_offset: accepted, expected_offset: accepted };
      });
    } catch (e) {
      if (diskFailure === null) throw e;
      // 디스크 참 등. 종결자는 API 하나다 (설계 §7) — 위 트랜잭션이 롤백된 뒤,
      // 별도 트랜잭션으로 job/meeting을 닫는다 (start()의 io_error 처리와 같은 모양).
      //
      // 하지만 그 롤백이 잠금을 반납한 순간부터 이 회복 트랜잭션이 시작될 때까지는 창이다 —
      // 그 사이 같은 오프셋의 정당한 재시도(잃어버린 ACK 재전송)가 끼어들어 먼저 append를
      // 커밋해 세션을 살려 놨을 수 있다. meeting.status는 그 재시도가 성공해도 여전히
      // 'recording'이라 그 값만으로는 구별이 안 된다 — 실제로 "아무도 안 끼어들었다"를
      // 말해주는 건 파일이 우리가 쓰려던 오프셋에서 전진하지 않았다는 사실뿐이다. job →
      // meeting 순서로 다시 잠그고 네 가지를 전부 재확인한 뒤에만 마킹한다. 하나라도
      // 어긋나면 누군가 이겼다는 뜻이므로 마킹을 건너뛴다 — 이 요청 자체는 그래도 507이다.
      const { jobId } = diskFailure as { jobId: string };
      const err = { code: 'io_error', message: 'could not write live audio' };
      await this.db.withTransaction(async (c) => {
        const job = await this.live.lockJobById(c, jobId);
        const meeting = await this.meetings.lockById(c, id);
        if (!job || !meeting) return;
        if (meeting.status !== 'recording' || meeting.current_job_id !== jobId || job.sealed_bytes !== null) return;
        if ((await this.liveAudio.pcmSize(meeting.audio_key)) !== offset) return;
        await this.jobs.fail(c, jobId, { ...err, kind: 'PERMANENT', stage: 'capture', message: String(e) });
        await this.meetings.markFailed(c, id, err);
      });
      throw new HttpException({ code: 'io_error' }, 507);
    }
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
