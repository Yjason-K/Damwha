import { ChunkAccumulator, SR } from "./pcm-convert";
// Vite 문서가 명시한 워크릿 로딩 패턴: `new URL('./pcm-worklet.ts', import.meta.url)`은
// 정적 에셋 규칙("URL이 정적으로 분석 가능해야 하고, 아니면 코드가 그대로 남아 런타임
// 오류가 난다")을 따르지만, .ts 파일은 Vite의 에셋 목록에도 assetsInclude에도 없다 —
// 그 경로를 태우면 트랜스파일 없이 원본 TS 소스를 그대로 복사해 낸다(`declare global`
// 같은 TS 전용 구문이 그대로 남아 브라우저가 파싱조차 못 한다). `?worker&url`은 대상을
// Rollup 워커 빌드로 한 번 더 태워 TS→JS 트랜스파일을 거친 뒤 그 산출물의 URL만 돌려준다
// (Worker를 생성하지 않는다 — AudioWorkletNode가 필요한 건 URL이지 Worker 인스턴스가
// 아니다). `pnpm fe build` 후 `dist/assets/`에 실제 .js 파일이 나오는지로 검증했다.
import pcmWorkletUrl from "./pcm-worklet.ts?worker&url";

export const BUFFER_LIMIT_MS = 60_000;
export const BACKLOG_WARN_MS = 30_000;
const CHUNK_MS = 1024;

export type CaptureSupport =
  | { ok: true }
  | { ok: false; reason: "insecure" | "denied" | "no_device" };

/** 회의를 만들기 전에 부른다. 원 설계에서 회의 중간에 audio_device_failed로 터지던 실패를
 *  전부 시작 전으로 옮긴다 (설계 §5.2). */
export async function checkCaptureSupport(): Promise<CaptureSupport> {
  // insecure context에서는 navigator.mediaDevices 자체가 undefined다. localhost는
  // secure context지만 http://192.168.x.x는 아니다 — 기기를 분리하는 날 걸린다.
  if (!navigator.mediaDevices?.getUserMedia)
    return { ok: false, reason: "insecure" };
  try {
    const st = await navigator.permissions?.query({
      name: "microphone" as PermissionName,
    });
    if (st?.state === "denied") return { ok: false, reason: "denied" };
  } catch {
    /* permissions.query를 지원하지 않는 브라우저 — 계속 진행한다 */
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some((d) => d.kind === "audioinput")) {
    return { ok: false, reason: "no_device" };
  }
  return { ok: true };
}

export type RecorderFailure =
  | "buffer_overflow"
  | "device_ended"
  | "upload_failed";

/**
 * 재시도로 회복될 수 없는 업로드 거절. 일반 네트워크 실패는 같은 청크를 그대로 다시
 * 보내면 되지만(그래서 run()이 무한 재시도한다), 서버가 재동기화할 오프셋도 주지 않고
 * 거절한 경우는 다시 보내도 같은 답이 온다 — 60초 뒤 buffer_overflow로 죽는 대신
 * 그 자리에서 upload_failed로 끝낸다.
 */
export class LiveUploadRejected extends Error {}

/**
 * 서버가 스스로 봉인한 사유. 캡처 실패가 아니므로 RecorderFailure와 구별한다 —
 * duration_limit은 4시간 상한에 닿은 정상 종료이고, sealed는 스위퍼나 다른 경로가
 * 이 세션을 이미 닫았다는 뜻이다 (설계 §3.3·§4.2).
 */
export type ServerSeal = "sealed" | "duration_limit";

export interface RecorderStatus {
  backlogMs: number;
  failed: RecorderFailure | null;
  /** 서버가 봉인해 캡처가 끝났다. 봉인된 상태를 조회해 수렴시킬 근거다. */
  sealed: ServerSeal | null;
}

/**
 * 업로드 응답. 200과 409를 status로 구별한다 — 409를 "이 청크는 이미 서버에 있다"로
 * 뭉뚱그리면 결손 409(서버가 아직 이 청크를 못 받음)에서도 청크를 버려 구멍이 생긴다.
 * expected는 서버의 확정 경계이고, code가 있으면 재동기화가 아니라 종료 사유다.
 */
export interface PostResult {
  status: 200 | 409;
  expected: number;
  code?: ServerSeal;
}

export class LiveRecorder {
  offset = 0;
  status: RecorderStatus = { backlogMs: 0, failed: null, sealed: null };
  onStatus: (s: RecorderStatus) => void = () => {};

  private queue: { body: Uint8Array; elapsedMs: number }[] = [];
  private pump: Promise<void> | null = null;
  private meetingId = "";
  private startedAt = 0;
  /** 마지막으로 캡처된 프레임의 경과값. 큐에 못 들어간(청크 미완성) 꼬리를 stop()이
   *  봉인할 때, 그 시점(전송 시각)이 아니라 이 값(캡처 시각)을 실어 보낸다. */
  private lastCaptureElapsedMs = 0;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private readonly chunks = new ChunkAccumulator();

  constructor(
    private readonly deps: {
      postChunk: (
        id: string,
        offset: number,
        body: Uint8Array,
        elapsedMs: number,
      ) => Promise<PostResult>;
      postStop?: (
        id: string,
        offset: number,
        final: number,
        body: Uint8Array,
        elapsedMs: number,
        /** 캡처가 실패해서 끝났으면 그 사유. 서버가 meeting.capture_error에 남긴다
         *  (설계 §5.3·§7). null이면 정상 종료다. */
        failure: RecorderFailure | null,
      ) => Promise<PostResult>;
      retryDelayMs?: number;
      bufferLimitMs?: number;
    },
  ) {}

  enqueue(chunk: Uint8Array, elapsedMs = 0) {
    // 실패·서버 봉인 후에는 더 받지 않는다 — 업로드 루프는 이미 멈췄으니 계속 받으면
    // stop()이 잘라내야 할 구멍만 커진다(설계 §2.9와 같은 원칙, review finding 2와 한 벌).
    if (this.status.failed !== null || this.status.sealed !== null) return;
    this.queue.push({ body: chunk, elapsedMs });
    this.report();
    if (
      this.queue.length * CHUNK_MS >
      (this.deps.bufferLimitMs ?? BUFFER_LIMIT_MS)
    ) {
      // 무한 재시도 큐는 탭 OOM으로 끝나고 OOM은 조용한 손실이다 (설계 §2.9).
      this.fail("buffer_overflow");
      return;
    }
    if (!this.pump) {
      this.pump = this.run().finally(() => {
        this.pump = null;
      });
    }
  }

  /** 큐가 빌 때까지 (또는 실패까지) 기다린다. 테스트와 stop이 쓴다. */
  async drain(): Promise<void> {
    while (this.pump) await this.pump;
  }

  private wait(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.deps.retryDelayMs ?? 1000));
  }

  /**
   * 업로드 루프. 판정의 기준은 상태 코드가 아니라 **서버의 확정 경계**다 (설계 §3.3).
   *
   * 409라는 이유만으로 청크를 버리면 안 된다. expected가 이 청크의 *끝*일 때만 서버가
   * 이미 받았다는 뜻이고, expected가 이 청크의 *시작*이면 서버는 아직 못 받은 것이라
   * 같은 청크를 다시 보내야 한다. 옛 코드는 둘을 구별하지 않아 결손 409에서도 청크를
   * 버리고 전진했고, 그렇게 생긴 구멍은 봉인된 뒤에야 드러난다.
   */
  private async run(): Promise<void> {
    while (this.queue.length > 0 && this.status.failed === null) {
      const { body, elapsedMs } = this.queue[0];
      try {
        // elapsedMs는 이 청크가 "잡힌" 시각이다(enqueue 때 같이 실었다) — 지금(전송
        // 시각)을 다시 재면 백로그·재시도 대기가 그대로 오탐 갭으로 둔갑한다 (설계
        // §3.3.2, review finding 4).
        const res = await this.deps.postChunk(
          this.meetingId,
          this.offset,
          body,
          elapsedMs,
        );
        const end = this.offset + body.byteLength;
        if (res.code === "sealed" || res.code === "duration_limit") {
          // 서버가 이미 봉인했다. 일반 ACK로 dequeue하지 않는다 — 남은 청크는 절대
          // 받아들여지지 않으므로 캡처와 큐를 정리하고 봉인 상태를 노출한다 (설계 §4.2).
          this.sealedByServer(res.code);
          return;
        }
        if (res.expected === end) {
          this.offset = end;
          this.queue.shift();
        } else if (res.status === 409 && res.expected === this.offset) {
          // 서버는 아직 이 청크를 못 받았다. 청크를 보존하고 기존 retry delay 후 재전송한다.
          await this.wait();
        } else {
          throw new LiveUploadRejected("invalid audio acknowledgement");
        }
      } catch (e) {
        if (e instanceof LiveUploadRejected) {
          // 재동기화할 곳이 없는 거절 — 같은 청크를 다시 보내도 같은 답이다.
          this.fail("upload_failed");
          return;
        }
        // 네트워크 실패. 청크를 버리지 않고 그대로 다시 보낸다.
        await this.wait();
        continue;
      }
      this.report();
    }
  }

  private elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  private report() {
    this.status = { ...this.status, backlogMs: this.queue.length * CHUNK_MS };
    this.onStatus(this.status);
  }

  private fail(reason: RecorderFailure) {
    this.status = { ...this.status, failed: reason };
    this.onStatus(this.status);
    void this.teardown();
  }

  /**
   * 서버가 스스로 봉인했다. 캡처 실패가 아니므로 failed로 표시하지 않는다 — failed는
   * stop이 X-Capture-Error로 실어 보내 meeting.capture_error에 남는 값이라, 4시간 상한에
   * 정상 도달한 녹음을 "마이크가 끊겼다"와 같은 칸에 넣게 된다 (설계 §4.2).
   *
   * 남은 큐는 버린다. 서버 경계는 이미 최종이라 그 청크들은 무엇을 해도 받아들여지지
   * 않고, 들고 있으면 stop이 그 위에 꼬리를 이어 붙일 위험만 남는다.
   */
  private sealedByServer(code: ServerSeal) {
    this.queue = [];
    this.status = { ...this.status, sealed: code, backlogMs: 0 };
    this.onStatus(this.status);
    void this.teardown();
  }

  async start(meetingId: string, deviceId?: string): Promise<void> {
    this.meetingId = meetingId;
    this.stream = await navigator.mediaDevices.getUserMedia({
      // 셋 다 끈다. AGC와 노이즈 억제는 신호를 변형해 ECAPA 임베딩과 정본 STT를 같이
      // 나쁘게 만든다 (설계 §2.4).
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    try {
      // 요청한 sampleRate를 일부 브라우저는 생성자에서 곧바로 거부한다 — 이 생성자를
      // try 밖에 두면 그 실패가 마이크를 켜 둔 채로 빠져나간다(review finding 3).
      const ctx = new AudioContext({ sampleRate: SR });
      // this.ctx를 여기서 바로 세운다 — 아래 어느 단계에서 던지든 teardown()이 이 ctx를
      // 찾아 닫을 수 있어야 한다. 마이크를 얻은 뒤의 실패를 전부 같은 teardown()으로
      // 모은다 — 손으로 세 벌을 따로 만들면 다음 실패 경로가 하나 빠지기 쉽다.
      this.ctx = ctx;
      // 요청한 sampleRate를 user agent가 만족하지 않을 수 있다. 48 kHz PCM에 16 kHz
      // 헤더를 씌우면 느리고 낮아진 정본이 조용히 만들어진다 (설계 §2.3).
      if (ctx.sampleRate !== SR) {
        throw new Error(`browser gave ${ctx.sampleRate} Hz, need ${SR} Hz`);
      }
      await ctx.audioWorklet.addModule(pcmWorkletUrl);
      const node = new AudioWorkletNode(ctx, "pcm-processor");
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        // elapsedMs는 이 프레임이 도착한 지금 잰다 — POST 시각까지 미루면 네트워크
        // 지연·백로그가 그대로 캡처 경과에 섞인다 (설계 §3.3.2, review finding 4).
        this.lastCaptureElapsedMs = this.elapsedMs();
        const chunk = this.chunks.push(new Int16Array(e.data));
        if (chunk) this.enqueue(chunk, this.lastCaptureElapsedMs);
      };
      ctx.createMediaStreamSource(this.stream).connect(node);
      // getUserMedia의 권한 프롬프트 대기를 시계에서 뺀다 — 그 전에 시작하면 origin당
      // 첫 녹음마다 프롬프트 대기 시간만큼의 가짜 capture_gap이 영구히 남는다.
      this.startedAt = performance.now();
    } catch (err) {
      // 워크릿 로딩 실패든 sample rate 불일치든, 마이크와 AudioContext를 켜 둔 채로
      // start()가 실패하면 브라우저 녹음 표시등은 계속 켜져 있는데 아무것도 잡히지
      // 않는다 — 단순 누수보다 나쁜, 조용히 잘못된 사용자 신뢰다.
      await this.teardown();
      throw err;
    }
    // ended는 장치 제거·권한 회수다. 이걸 안 보면 워크릿이 무음을 계속 내보내 실제
    // 대화가 무음으로 기록된 채 회의가 정상 완료로 표시된다 (설계 §5.3).
    this.stream
      .getAudioTracks()[0]
      .addEventListener("ended", () => this.fail("device_ended"));
  }

  /**
   * 종료. `status.failed`를 stop 요청에 실어 보낸다 — 그것이 이 실패가 브라우저 탭
   * 바깥에 남는 유일한 통로다. 토스트와 배너는 탭을 닫으면 사라지고, 정본 오디오는
   * 짧아진 채 "정상 완료"로 보인다 (설계 §5.3·§7, review finding 3).
   */
  async stop(): Promise<void> {
    await this.teardown();
    await this.drain();
    // run()은 실패 후 큐를 비우지 않고 빠져나온다 — 그 위에 최신 꼬리를 이어 붙이면
    // [offset..][큐에 남은 구멍][꼬리]가 "정상 완료"로 봉인된다. 큐를 보낼 방법은
    // 없으니(업로드 루프가 이미 멈췄다) 마지막으로 확인된 연속 바이트에서 빈 바디로
    // 봉인한다 (review finding 2).
    const tail =
      this.queue.length > 0 ? new Uint8Array(0) : this.chunks.flush();
    // 큐가 비어 있어도 failed는 실어 보낸다 — device_ended가 큐가 빈 순간에 오면
    // 꼬리는 온전하지만 그 뒤로 아무것도 잡히지 않았다는 사실은 그대로 남아야 한다.
    const res = await this.deps.postStop?.(
      this.meetingId,
      this.offset,
      this.offset + tail.byteLength,
      tail,
      this.lastCaptureElapsedMs,
      this.status.failed,
    );
    if (res && res.status === 409 && res.expected > this.offset) {
      // 서버의 확정 경계가 우리보다 앞서 있다 — 우리가 못 받은 ACK가 있었다는 뜻이다.
      // 그 앞에 로컬 꼬리를 덧붙이면 서버가 이미 확정한 바이트 위에 구멍을 낸다.
      // 서버 경계에서 빈 stop으로 다시 봉인한다 (설계 §7). 로컬 미전송 PCM은 버린다 —
      // 그것을 성공으로 표시하는 것보다 짧은 녹음이 정직하다.
      this.offset = res.expected;
      await this.deps.postStop?.(
        this.meetingId,
        this.offset,
        this.offset,
        new Uint8Array(0),
        this.lastCaptureElapsedMs,
        this.status.failed,
      );
    }
  }

  private async teardown() {
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
