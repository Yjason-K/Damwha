import { ChunkAccumulator, SR } from "./pcm-convert";
import type { WorkletCommand, WorkletEvent } from "./pcm-worklet-protocol";
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

/**
 * 준비 단계의 ACK 한도 (설계 §6.4). ctx.resume·ready·begun이 각각 이 시간을 받는다.
 * 권한 프롬프트에는 **의도적으로** 걸지 않는다 — 사람이 프롬프트를 읽는 시간을 실패로
 * 세면 origin당 첫 녹음이 반응 속도 때문에 실패한다.
 */
export const PREPARE_ACK_TIMEOUT_MS = 5_000;
/** flush ACK 한도 (설계 §7). 넘기면 capture_flush_failed를 남기고 받은 데까지만 봉인한다. */
export const FLUSH_ACK_TIMEOUT_MS = 2_000;
/** 정상 stop이 남은 큐를 비우는 데 쓰는 한도 (설계 §7). */
export const DRAIN_TIMEOUT_MS = 60_000;
/** 캡처 상한 4시간 (설계 §4.2). begin ACK를 기준으로 잰다. */
export const MAX_CAPTURE_MS = 4 * 60 * 60 * 1000;

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
  | "upload_failed"
  | "capture_flush_failed";

/**
 * 재시도로 회복될 수 없는 업로드 거절. 일반 네트워크 실패는 같은 청크를 그대로 다시
 * 보내면 되지만(그래서 run()이 무한 재시도한다), 서버가 재동기화할 오프셋도 주지 않고
 * 거절한 경우는 다시 보내도 같은 답이 온다 — 60초 뒤 buffer_overflow로 죽는 대신
 * 그 자리에서 upload_failed로 끝낸다.
 */
export class LiveUploadRejected extends Error {}

/**
 * 준비가 취소됐다. 실패가 아니라 사용자의 취소·다른 시작에 밀린 것이므로, 호출자가
 * 오류 토스트를 띄우지 않고 조용히 접을 수 있도록 다른 타입으로 구별한다 (설계 §6.4).
 */
export class LiveCaptureCancelled extends Error {
  constructor(message = "capture preparation was cancelled") {
    super(message);
  }
}

/**
 * 서버가 스스로 봉인한 사유. 캡처 실패가 아니므로 RecorderFailure와 구별한다 —
 * duration_limit은 4시간 상한에 닿은 정상 종료이고, sealed는 스위퍼나 다른 경로가
 * 이 세션을 이미 닫았다는 뜻이다 (설계 §3.3·§4.2).
 */
export type ServerSeal = "sealed" | "duration_limit";

/**
 * 레코더의 수명 (설계 §6). 실패는 어디서 나든 자원을 반납하고 stopped로 수렴한다.
 * prepared 이전에는 회의 id가 없고, 회의를 만들 자격은 prepared에만 있다.
 */
export type RecorderPhase =
  | "idle"
  | "preparing"
  | "prepared"
  | "recording"
  | "stopping"
  | "stopped";

export interface RecorderStatus {
  backlogMs: number;
  failed: RecorderFailure | null;
  /** 서버가 봉인해 캡처가 끝났다. 봉인된 상태를 조회해 수렴시킬 근거다. */
  sealed: ServerSeal | null;
  /**
   * `sealed !== null`을 그대로 옮긴 값 — 사유는 필요 없고 "서버가 닫았는가"만 묻는 화면을
   * 위한 것이다. 두 필드가 어긋날 수 없도록 `setSealed()` **한 곳**에서만 파생시킨다.
   */
  sealedByServer: boolean;
  phase: RecorderPhase;
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

/** 값 하나를 밖에서 settle하는 슬롯. Worklet ACK를 기다리는 데 쓴다. */
function ackSlot() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * 정해진 시간 안에 끝나지 않으면 던진다. 성공하면 타이머를 반드시 지운다 — 남겨 두면
 * 이미 끝난 준비가 몇 초 뒤에 깨어나 테스트의 fake timer와 실제 탭 모두를 어지럽힌다.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class LiveRecorder {
  offset = 0;
  status: RecorderStatus = {
    backlogMs: 0,
    failed: null,
    sealed: null,
    sealedByServer: false,
    phase: "idle",
  };
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
  private node: AudioWorkletNode | null = null;
  private readonly chunks = new ChunkAccumulator();
  /**
   * prepare/dispose가 겹칠 때 누가 주인인지 가른다. dispose가 이 값을 올리면 진행 중인
   * prepare는 다음 await 뒤에 자기가 밀렸음을 알고, 늦게 받은 스트림을 즉시 닫는다.
   */
  private generation = 0;
  private ready = ackSlot();
  private begun = ackSlot();
  private flushed = ackSlot();
  private flushDone = false;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 실패·봉인 뒤에 `enqueue`가 되돌려보낸 청크가 있는가.
   *
   * `device_ended`의 flush 창이 이걸 필요로 한다: fail()이 flush를 보낸 뒤 도착한 자투리가
   * accumulator에서 완전한 청크를 완성하면 `enqueue`가 그것을 버리는데(이미 failed),
   * 남은 나머지는 accumulator에 남는다. 그 나머지를 stop 바디로 실으면 **구멍 앞** 경계에
   * **구멍 뒤** 바이트를 쓰게 된다 — 설계 §7이 금지하는 "구멍 뒤의 꼬리 이어 붙이기"다.
   */
  private droppedChunk = false;
  /** 중복 stop은 같은 Promise를 돌려준다 (설계 §7). */
  private stopping: Promise<void> | null = null;
  /** 자원 반납은 한 번만 돈다. 정상 종료·실패 종료가 같은 이 경로를 쓴다. */
  private releasing: Promise<void> | null = null;

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

  // ── 준비 ────────────────────────────────────────────────────────────────

  /**
   * 마이크·AudioContext·Worklet을 회의 **없이** 먼저 확보한다 (설계 §6).
   *
   * 이 순서가 이 클래스의 존재 이유다. 회의를 먼저 만들면 권한 거절·장치 부재·Worklet
   * 로딩 실패가 전부 빈 회의를 서버에 남기고, 그 회의는 부분 유일 인덱스로 다음 녹음까지
   * 막는다. 여기까지 성공한 캡처만 `/meetings/live`를 부를 자격을 얻는다.
   */
  async prepare(deviceId?: string): Promise<void> {
    if (this.status.phase !== "idle") {
      throw new Error(`cannot prepare a recorder in ${this.status.phase}`);
    }
    const gen = this.generation;
    this.setPhase("preparing");
    let stream: MediaStream;
    try {
      // 권한 프롬프트에는 시간 제한을 두지 않는다 (설계 §6.4).
      stream = await navigator.mediaDevices.getUserMedia({
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
    } catch (err) {
      await this.endCapture();
      throw err;
    }
    // 취소된 prepare가 늦게 스트림을 얻었다. 이 스트림의 주인은 아무도 아니므로 그 자리에서
    // 닫는다 — 붙들고 있으면 브라우저 녹음 표시등만 켜진 채 남는다 (설계 §6.4).
    if (gen !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      throw new LiveCaptureCancelled();
    }
    this.stream = stream;

    try {
      // 요청한 sampleRate를 일부 브라우저는 생성자에서 곧바로 거부한다 — 이 생성자를
      // try 밖에 두면 그 실패가 마이크를 켜 둔 채로 빠져나간다(review finding 3).
      const ctx = new AudioContext({ sampleRate: SR });
      // this.ctx를 여기서 바로 세운다 — 아래 어느 단계에서 던지든 release()가 이 ctx를
      // 찾아 닫을 수 있어야 한다.
      this.ctx = ctx;
      // 요청한 sampleRate를 user agent가 만족하지 않을 수 있다. 48 kHz PCM에 16 kHz
      // 헤더를 씌우면 느리고 낮아진 정본이 조용히 만들어진다 (설계 §2.3).
      if (ctx.sampleRate !== SR) {
        throw new Error(`browser gave ${ctx.sampleRate} Hz, need ${SR} Hz`);
      }
      await ctx.audioWorklet.addModule(pcmWorkletUrl);
      this.checkGeneration(gen);

      const node = new AudioWorkletNode(ctx, "pcm-processor");
      this.node = node;
      // 핸들러를 연결 **전에** 건다 — ready는 첫 유효 입력 quantum에서 오므로 연결 뒤에
      // 걸면 그 첫 메시지를 놓칠 수 있다.
      node.port.onmessage = (e: MessageEvent<WorkletEvent>) =>
        this.onWorkletEvent(e.data);
      ctx.createMediaStreamSource(stream).connect(node);
      // gain=0을 거쳐 destination에 잇는다 — 연결되지 않은 노드는 처리 수명을 잃고,
      // 그냥 이으면 마이크 소리가 스피커로 되돌아 하울링이 된다 (설계 §7).
      const silent = ctx.createGain();
      silent.gain.value = 0;
      node.connect(silent);
      silent.connect(ctx.destination);

      await withTimeout(
        Promise.resolve(ctx.resume()),
        PREPARE_ACK_TIMEOUT_MS,
        "the audio context did not resume in time",
      );
      this.checkGeneration(gen);
      await withTimeout(
        this.ready.promise,
        PREPARE_ACK_TIMEOUT_MS,
        "the capture worklet never reported ready",
      );
      this.checkGeneration(gen);
    } catch (err) {
      // 워크릿 로딩 실패든 sample rate 불일치든, 마이크와 AudioContext를 켜 둔 채로
      // prepare()가 실패하면 브라우저 녹음 표시등은 계속 켜져 있는데 아무것도 잡히지
      // 않는다 — 단순 누수보다 나쁜, 조용히 잘못된 사용자 신뢰다.
      await this.endCapture();
      throw err;
    }
    this.setPhase("prepared");
  }

  /**
   * 준비된 캡처를 이 회의에 붙인다 (설계 §6.5·§6.6). begun ACK를 받은 시점이 캡처 시계의
   * 0이고, 4시간 상한도 여기서부터 잰다.
   */
  async begin(meetingId: string): Promise<void> {
    if (this.status.phase !== "prepared") {
      throw new Error(`cannot begin a recorder in ${this.status.phase}`);
    }
    this.meetingId = meetingId;
    try {
      this.post({ type: "begin" });
      await withTimeout(
        this.begun.promise,
        PREPARE_ACK_TIMEOUT_MS,
        "the capture worklet never acknowledged begun",
      );
    } catch (err) {
      // 자원은 여기서 반납한다. 서버에 남은 회의는 호출자가 0바이트 stop으로 정리한다 —
      // 그 id를 아는 것은 호출자뿐이 아니지만, 정리 정책(재시도 금지)은 호출자 몫이다.
      await this.endCapture();
      throw err;
    }
    // getUserMedia의 권한 프롬프트 대기를 시계에서 뺀다 — 그 전에 시작하면 origin당
    // 첫 녹음마다 프롬프트 대기 시간만큼의 가짜 capture_gap이 영구히 남는다.
    this.startedAt = performance.now();
    this.captureTimer = setTimeout(() => void this.stop(), MAX_CAPTURE_MS);
    // ended는 장치 제거·권한 회수다. 이걸 안 보면 워크릿이 무음을 계속 내보내 실제
    // 대화가 무음으로 기록된 채 회의가 정상 완료로 표시된다 (설계 §5.3).
    this.stream
      ?.getAudioTracks()[0]
      ?.addEventListener("ended", () => this.fail("device_ended"));
    this.setPhase("recording");
  }

  /** 회의를 만들기 전의 취소·실패 정리. 서버로는 아무것도 보내지 않는다 (설계 §6.6). */
  async dispose(): Promise<void> {
    // 진행 중인 prepare의 소유권을 뺏는다 — 그 prepare는 다음 await 뒤에 스스로 접는다.
    this.generation += 1;
    await this.endCapture();
  }

  /**
   * 캡처의 끝 — 자원을 반납하고 `stopped`로 수렴시킨다. 설계 §6이 요구하는 "실패는
   * 리소스를 반납하고 stopped로 수렴한다"의 구현이며, **모든** 종단 경로(prepare 실패,
   * begin 실패, dispose, 캡처 실패, 서버 봉인)가 이 꼬리를 공유한다. 이것이 없으면
   * 마이크·노드·ctx가 이미 사라진 뒤에도 phase가 "recording"으로 남아, phase를 보는
   * 화면은 존재하지 않는 녹음을 살아 있다고 읽는다.
   */
  private endCapture(flush = false): Promise<void> {
    return this.release({ flush }).finally(() => this.setPhase("stopped"));
  }

  private checkGeneration(gen: number) {
    if (gen !== this.generation) throw new LiveCaptureCancelled();
  }

  private post(command: WorkletCommand) {
    this.node?.port.postMessage(command);
  }

  private onWorkletEvent(event: WorkletEvent) {
    switch (event.type) {
      case "ready":
        this.ready.resolve();
        return;
      case "begun":
        this.begun.resolve();
        return;
      case "flushed":
        this.flushDone = true;
        this.flushed.resolve();
        return;
      case "pcm":
        // elapsedMs는 이 프레임이 도착한 지금 잰다 — POST 시각까지 미루면 네트워크
        // 지연·백로그가 그대로 캡처 경과에 섞인다 (설계 §3.3.2, review finding 4).
        this.lastCaptureElapsedMs = this.elapsedMs();
        // push는 완전 청크 배열을 준다(입력 길이와 무관 — 설계 §7); 전부 enqueue한다.
        for (const chunk of this.chunks.push(new Int16Array(event.pcm))) {
          this.enqueue(chunk, this.lastCaptureElapsedMs);
        }
        return;
    }
  }

  // ── 업로드 ──────────────────────────────────────────────────────────────

  enqueue(chunk: Uint8Array, elapsedMs = 0) {
    // 실패·서버 봉인 후에는 더 받지 않는다 — 업로드 루프는 이미 멈췄으니 계속 받으면
    // stop()이 잘라내야 할 구멍만 커진다(설계 §2.9와 같은 원칙, review finding 2).
    // 버렸다는 사실은 남긴다: 버린 청크는 정본의 구멍이고, sendStop이 그 뒤의 자투리를
    // 실으면 안 된다.
    if (this.status.failed !== null || this.status.sealed !== null) {
      this.droppedChunk = true;
      return;
    }
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
          this.markServerSeal(res.code);
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

  private setPhase(phase: RecorderPhase) {
    this.status = { ...this.status, phase };
    this.onStatus(this.status);
  }

  private report() {
    this.status = { ...this.status, backlogMs: this.queue.length * CHUNK_MS };
    this.onStatus(this.status);
  }

  /**
   * 캡처 실패. **첫 원인이 이긴다** — 서버의 meeting.capture_error도 같은 규칙이라
   * (설계 §7), 나중 사유가 덮으면 "마이크가 끊겼다"가 "flush를 못 했다"로 바뀐다.
   */
  private recordFailure(reason: RecorderFailure) {
    if (this.status.failed !== null) return;
    this.status = { ...this.status, failed: reason };
    this.onStatus(this.status);
  }

  private fail(reason: RecorderFailure) {
    // 자원 반납을 **먼저** 건다. release()의 첫 문장이 트랙 정지라, 이 순서라야
    // upload_failed 토스트가 뜨는 시점에 마이크가 이미 꺼져 있다 (설계 §7).
    // device_ended는 Worklet이 들고 있는 자투리가 아직 진짜 오디오이므로 flush를 시도한다.
    void this.endCapture(reason === "device_ended");
    this.recordFailure(reason);
  }

  /**
   * 서버가 스스로 봉인했다. 캡처 실패가 아니므로 failed로 표시하지 않는다 — failed는
   * stop이 X-Capture-Error로 실어 보내 meeting.capture_error에 남는 값이라, 4시간 상한에
   * 정상 도달한 녹음을 "마이크가 끊겼다"와 같은 칸에 넣게 된다 (설계 §4.2).
   *
   * 남은 큐는 버린다. 서버 경계는 이미 최종이라 그 청크들은 무엇을 해도 받아들여지지
   * 않고, 들고 있으면 stop이 그 위에 꼬리를 이어 붙일 위험만 남는다.
   */
  private markServerSeal(code: ServerSeal) {
    this.queue = [];
    void this.endCapture();
    this.setSealed(code);
  }

  /**
   * `status.sealed`를 바꾸는 **유일한** 자리. `sealedByServer`를 여기서만 파생시켜 둘이
   * 어긋날 수 없게 한다 — 두 필드를 호출 지점마다 따로 세우면 언젠가 한쪽만 갱신된다.
   * (초기값은 생성자의 리터럴 `sealed: null` / `sealedByServer: false`로 같은 관계다.)
   */
  private setSealed(sealed: ServerSeal | null) {
    this.status = {
      ...this.status,
      sealed,
      sealedByServer: sealed !== null,
      backlogMs: this.queue.length * CHUNK_MS,
    };
    this.onStatus(this.status);
  }

  // ── 종료 ────────────────────────────────────────────────────────────────

  /**
   * 종료: flush → ACK → 자원 반납 → drain → stop 자투리 (설계 §7).
   *
   * `status.failed`를 stop 요청에 실어 보낸다 — 그것이 이 실패가 브라우저 탭 바깥에
   * 남는 유일한 통로다. 토스트와 배너는 탭을 닫으면 사라지고, 정본 오디오는 짧아진 채
   * "정상 완료"로 보인다 (설계 §5.3·§7).
   *
   * 중복 호출은 같은 Promise를 돌려준다 — 배너의 연타나 4시간 타이머와 사용자의 종료가
   * 겹쳐도 stop POST는 하나여야 한다.
   */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = this.runStop().finally(() => {
        this.setPhase("stopped");
      });
    }
    return this.stopping;
  }

  private async runStop(): Promise<void> {
    // 이미 실패·봉인으로 stopped에 수렴했으면 되돌리지 않는다 — 그때 남은 일은 서버 봉인뿐이고
    // 감아 내릴 캡처가 없다. phase는 앞으로만 간다.
    if (this.status.phase !== "stopped") this.setPhase("stopping");
    // flush ACK를 기다린 뒤에 자원을 반납한다. 순서가 뒤집히면 Worklet이 들고 있던
    // 마지막 자투리(1–16,383샘플)가 매 녹음마다 조용히 사라진다 (설계 §7).
    // 여기서는 endCapture가 아니라 release를 부른다 — drain과 stop POST가 끝날 때까지
    // "stopping"이 유지돼야 하고, stopped로의 수렴은 stop()의 finally가 맡는다.
    await this.release({ flush: true });
    try {
      await withTimeout(this.drain(), DRAIN_TIMEOUT_MS, "drain timed out");
    } catch {
      // 60초 안에 큐를 비우지 못했다. 마이크는 이미 꺼져 있고, 남은 큐는 구멍이므로
      // 아래에서 마지막 확인 경계에 빈 stop을 보낸다 (설계 §7).
      this.recordFailure("upload_failed");
    }
    await this.sendStop();
  }

  private async sendStop(): Promise<void> {
    if (!this.deps.postStop) return;
    // run()은 실패 후 큐를 비우지 않고 빠져나온다 — 그 위에 최신 꼬리를 이어 붙이면
    // [offset..][큐에 남은 구멍][꼬리]가 "정상 완료"로 봉인된다. 큐를 보낼 방법은
    // 없으니(업로드 루프가 이미 멈췄다) 마지막으로 확인된 연속 바이트에서 빈 바디로
    // 봉인한다 (review finding 2).
    // 빈 바디로 봉인해야 하는 세 가지 구멍:
    //  - 큐에 못 보낸 청크가 남았다(업로드 루프가 이미 멈췄다),
    //  - 실패·봉인 뒤에 되돌려보낸 청크가 있다(flush 자투리가 완성한 청크를 포함한다),
    //  - 서버가 스스로 봉인해 로컬 바이트가 절대 받아들여지지 않는다.
    // 셋 중 하나라도 참이면 마지막으로 확인된 연속 경계에서 빈 바디로 끝낸다 (설계 §7).
    const tail =
      this.queue.length > 0 || this.droppedChunk || this.status.sealed !== null
        ? new Uint8Array(0)
        : this.chunks.flush();
    // 큐가 비어 있어도 failed는 실어 보낸다 — device_ended가 큐가 빈 순간에 오면
    // 꼬리는 온전하지만 그 뒤로 아무것도 잡히지 않았다는 사실은 그대로 남아야 한다.
    const res = await this.deps.postStop(
      this.meetingId,
      this.offset,
      this.offset + tail.byteLength,
      tail,
      this.lastCaptureElapsedMs,
      this.status.failed,
    );
    if (res.status === 200) return;
    if (res.code) {
      // 서버가 스스로 닫았다 — 우리 경계로 다시 봉인할 것이 없다 (설계 §4.2).
      this.markServerSeal(res.code);
      return;
    }
    if (res.expected <= this.offset) {
      // 서버 경계가 우리보다 뒤이거나 같은데 거절했다. 재동기화할 곳이 없으므로 여기서
      // 조용히 성공으로 접지 않는다 — 회의는 recording에 남아 orphan 스캐너를 기다린다.
      this.recordFailure("upload_failed");
      return;
    }
    // 서버의 확정 경계가 우리보다 앞서 있다 — 우리가 못 받은 ACK가 있었다는 뜻이다.
    // 그 앞에 로컬 꼬리를 덧붙이면 서버가 이미 확정한 바이트 위에 구멍을 낸다.
    // 서버 경계에서 빈 stop으로 다시 봉인한다 (설계 §7). 로컬 미전송 PCM은 버린다 —
    // 그것을 성공으로 표시하는 것보다 짧은 녹음이 정직하다.
    this.offset = res.expected;
    const retry = await this.deps.postStop(
      this.meetingId,
      this.offset,
      this.offset,
      new Uint8Array(0),
      this.lastCaptureElapsedMs,
      this.status.failed,
    );
    if (retry.status === 200) return;
    if (retry.code) {
      this.markServerSeal(retry.code);
      return;
    }
    // 재시도마저 거절됐다. 이 세션은 브라우저가 봉인하지 못한다 — 조용히 성공으로 접으면
    // 화면은 정상 종료를 보여주는데 회의는 recording에 갇혀 있다.
    this.recordFailure("upload_failed");
  }

  /**
   * 자원 반납의 **유일한** 경로. 정상 종료·flush 실패·업로드 실패·서버 봉인이 전부
   * 여기로 모인다 — 손으로 여러 벌을 만들면 다음 실패 경로가 하나 빠지기 쉽다.
   * 여러 번 불려도 한 번만 돈다.
   */
  private release(options: { flush?: boolean } = {}): Promise<void> {
    if (!this.releasing) this.releasing = this.runRelease(options.flush);
    return this.releasing;
  }

  private async runRelease(flush = false): Promise<void> {
    if (this.captureTimer !== null) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
    // Worklet이 들고 있는 것을 먼저 받아 낸다. 설계 §7의 순서가 그대로다 —
    // "flushed까지 전달된 PCM을 모두 누적한 뒤 노드 disconnect, track.stop,
    // AudioContext.close". 이 순서가 뒤집혀 있어서 마지막 자투리가 매번 사라졌다.
    //
    // flush를 기다리지 않는 실패 경로(업로드 실패·버퍼 폭주)에서는 이 블록을 건너뛰므로
    // 트랙 정지가 동기적으로 먼저 일어난다 — upload_failed 문구가 뜰 때 마이크는 이미 꺼져
    // 있어야 한다 (설계 §7).
    if (flush && this.node && !this.flushDone) {
      this.post({ type: "flush" });
      try {
        await withTimeout(
          this.flushed.promise,
          FLUSH_ACK_TIMEOUT_MS,
          "the capture worklet never acknowledged flush",
        );
      } catch {
        // 받아 둔 연속 PCM까지만 봉인한다. 기존 사유(device_ended 등)는 덮지 않는다.
        this.recordFailure("capture_flush_failed");
      }
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node?.disconnect();
    this.node = null;
    const ctx = this.ctx;
    this.ctx = null;
    await ctx?.close().catch(() => undefined);
  }
}
