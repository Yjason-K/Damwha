import { refreshEnv, type ApiEnv, type LoadedConfig } from "./config";
import { PREPARE_DERIVED_KEYS } from "./services/embed";

/**
 * 재시도가 config.json을 다시 읽는 **판정**. main.ts에는 electron을 읽는 잎(userData 경로,
 * 로그 함수, 살아 있는 LaunchContext)만 남는다.
 *
 * 이 파일이 생긴 이유는 재리뷰가 낸 결함 둘이 정확히 여기 있었기 때문이다 — 파생 키를 다시
 * 읽으면서 파생을 다시 돌리지 않은 것(§4-1)과, WORKER_ID가 재시도마다 새로 발급된 것(§4-2).
 * 둘 다 main.ts의 열 줄짜리 함수 안이라 어떤 테스트도 부를 수 없었다(electron을 값으로
 * import하는 파일은 vitest가 못 불러온다 — shell-window.ts:4).
 */

/**
 * 실행 중에는 **바꾸지 않고 보고만 하는** 키.
 *
 * 둘의 근거가 다르다.
 *
 *  - embed의 파생 키 셋: 한 값에서 둘을 파생하는데 파생을 다시 돌릴 수 없다(retry()는 설계상
 *    prepare()를 건너뛴다). 다시 읽으면 URL과 PORT가 어긋나고, 어긋난 결과는 오류가 아니라
 *    조용한 degrade다 (services/embed.ts의 PREPARE_DERIVED_KEYS 주석).
 *  - WORKER_ID: 이 실행의 **신분**이다. 살아 있는 worker 밑에서 바뀌면 백오프가 되살린
 *    worker가 새 id로 떠서 옛 id로 locked_by가 찍힌 job을 다시 집지 못한다 (스펙 §6.5).
 *    실행 중에 신분을 갈아 끼우는 것은 어떤 경우에도 답이 아니다.
 */
export const RESTART_ONLY_KEYS: readonly string[] = [...PREPARE_DERIVED_KEYS, "WORKER_ID"];

export interface ConfigReloadDeps {
  /** config.json을 다시 읽는다 (main.ts: loadConfig(app.getPath("userData"))). */
  load(): LoadedConfig;
  /**
   * 살아 있는 감독자의 env와, 그것을 만든 파일 값(baseline). 감독자가 아직 없으면 null —
   * 그때는 읽을 이유가 없다. 감독자 생성 경로가 어차피 파일을 처음부터 읽는다.
   */
  live(): { env: ApiEnv; baseline: ApiEnv } | null;
  log(line: string): void;
}

/**
 * 재적용기를 만든다. 돌려주는 함수는 "이 값은 앱을 다시 켜야 바뀝니다" 안내를 돌려주고,
 * 부르는 쪽(main.ts)이 그것을 실패 화면에 얹는다. 화면이 말하지 않으면 사용자는 자기 수정이
 * 왜 안 먹는지 알 길이 없고, 그 침묵이 §4-1의 절반이었다.
 *
 * 팩토리인 이유는 **중복 로그 억제 상태**를 들기 위해서다. 같은 경고를 재시도마다(3·8·20초)
 * 다시 적으면 supervisor.log에서 새 사건과 반복이 구별되지 않는다. renderStatus는 이미
 * lastStatusLine으로 같은 일을 하는데 이 경로에만 그것이 없었다 (재리뷰 §4-6).
 */
export function createConfigReloader(deps: ConfigReloadDeps): () => string | null {
  let lastWarning = "";
  let lastNotice = "";

  return (): string | null => {
    const live = deps.live();
    if (live === null) return null;

    const cfg = deps.load();
    const warning = cfg.warning ?? "";
    if (warning !== lastWarning) {
      lastWarning = warning;
      if (warning !== "") deps.log(warning);
    }

    const { changed, removed, needsRestart } = refreshEnv(
      live.env,
      live.baseline,
      cfg.env,
      RESTART_ONLY_KEYS,
    );
    // 갱신·삭제는 되풀이될 수 없다(baseline이 같이 움직인다). 그래서 여기는 디듀프하지 않는다 —
    // 이 줄이 한 번 더 보인다면 파일이 실제로 또 바뀐 것이다.
    const applied: string[] = [];
    if (changed.length > 0) applied.push(`바뀐 키: ${changed.join(", ")}`);
    if (removed.length > 0) applied.push(`지운 키: ${removed.join(", ")}`);
    if (applied.length > 0) deps.log(`config.json을 다시 읽었어요 — ${applied.join(" / ")}`);

    if (needsRestart.length === 0) {
      lastNotice = "";
      return null;
    }
    const notice = `${needsRestart
      .map((r) => `${r.key}은(는) 파일에 ${r.file}, 실행 중인 값은 ${r.live}`)
      .join(" / ")} — 이 키는 앱을 다시 켜야 바뀌어요.`;
    if (notice !== lastNotice) {
      lastNotice = notice;
      deps.log(notice);
    }
    return notice;
  };
}
