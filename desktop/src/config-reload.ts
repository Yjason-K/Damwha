import { refreshEnv, withoutDbKeys, type ApiEnv, type DatabaseMode, type LoadedConfig } from "./config";
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

/** 재적용 한 번의 결과. */
export interface ConfigReloadResult {
  /** 실패 화면에 얹을 "다시 켜야 바뀌어요" 안내. 어긋남이 없으면 null. */
  notice: string | null;
  /**
   * 이 안내가 **직전 재적용과 다르다** = 사용자에게 아직 말하지 않은 새 내용이다.
   *
   * 부르는 쪽이 이것으로 대화상자를 띄울지 가른다. 담화 화면이 붙은 뒤에는 셸 화면이 다시
   * 그려지지 않으므로(shell-latch.ts) 안내가 갈 곳이 없는데, embed는 게이트가 아니라서
   * "API는 running, embed만 failed"가 설계상 정상이고(스펙 §6.7) 그 상태에서 사용자가
   * 고치는 값이 바로 EMBED_SERVICE_PORT다 — 안내가 가장 필요한 조합이 정확히 안내가
   * 사라지는 조합이었다 (재재리뷰 §3-2). 그렇다고 재시도마다 띄우면 모달이 쌓인다.
   * 어긋남이 없을 때는 항상 false다 — 띄울 것이 없다.
   */
  isNew: boolean;
}

export interface ConfigReloadDeps {
  /** config.json을 다시 읽는다 (main.ts: loadConfig(app.getPath("userData"))). */
  load(): LoadedConfig;
  /**
   * 살아 있는 감독자의 env와, 그것을 만든 파일 값(baseline — DB 키를 뺀 것), 그리고 감독자를 만들 때 정한 DB 모드.
   * 감독자가 아직 없으면 null.
   */
  live(): { env: ApiEnv; baseline: ApiEnv; mode: DatabaseMode } | null;
  log(line: string): void;
}

/** 화면·로그에 싣는 모드 이름. URL의 비밀번호는 가린다 — 이 문구는 supervisor.log와 대화상자에 남는다. */
export function describeMode(m: DatabaseMode): string {
  if (m.kind === "embedded") return "내장 DB";
  try {
    const u = new URL(m.url);
    if (u.password !== "") u.password = "***";
    return `외부 DB(디버깅) ${u.toString()}`;
  } catch {
    return "외부 DB(디버깅)";
  }
}

function sameMode(a: DatabaseMode, b: DatabaseMode): boolean {
  if (a.kind === "embedded" || b.kind === "embedded") return a.kind === b.kind;
  return a.url === b.url;
}

/**
 * 재적용기를 만든다. 돌려주는 함수는 "이 값은 앱을 다시 켜야 바뀝니다" 안내와, 그것이 **새
 * 내용인지**를 돌려주고, 부르는 쪽(main.ts)이 앞엣것을 실패 화면에 얹고 뒤엣것으로 대화상자를
 * 가른다. 화면이 말하지 않으면 사용자는 자기 수정이 왜 안 먹는지 알 길이 없고, 그 침묵이
 * §4-1의 절반이었다.
 *
 * 팩토리인 이유는 **중복 로그 억제 상태**를 들기 위해서다. 같은 경고를 재시도마다(3·8·20초)
 * 다시 적으면 supervisor.log에서 새 사건과 반복이 구별되지 않는다. renderStatus는 이미
 * lastStatusLine으로 같은 일을 하는데 이 경로에만 그것이 없었다 (재리뷰 §4-6).
 */
export function createConfigReloader(deps: ConfigReloadDeps): () => ConfigReloadResult {
  let lastWarning = "";
  let lastNotice = "";

  return (): ConfigReloadResult => {
    const live = deps.live();
    if (live === null) return { notice: null, isNew: false };

    const cfg = deps.load();
    const warning = cfg.warning ?? "";
    if (warning !== lastWarning) {
      lastWarning = warning;
      if (warning !== "") deps.log(warning);
    }

    // DB 키는 넘기지 않는다. 모드가 정하는 값이라 파일로 바뀌지 않고, 지운다고 사라지지도 않는다 (스펙 §6.6).
    const { changed, removed, needsRestart } = refreshEnv(
      live.env,
      live.baseline,
      withoutDbKeys(cfg.env),
      RESTART_ONLY_KEYS,
    );
    // 갱신·삭제는 되풀이될 수 없다(baseline이 같이 움직인다). 그래서 여기는 디듀프하지 않는다 —
    // 이 줄이 한 번 더 보인다면 파일이 실제로 또 바뀐 것이다.
    const applied: string[] = [];
    if (changed.length > 0) applied.push(`바뀐 키: ${changed.join(", ")}`);
    if (removed.length > 0) applied.push(`지운 키: ${removed.join(", ")}`);
    if (applied.length > 0) deps.log(`config.json을 다시 읽었어요 — ${applied.join(" / ")}`);

    const notices: string[] = [];
    if (needsRestart.length > 0) {
      notices.push(
        `${needsRestart.map((r) => `${r.key}은(는) 파일에 ${r.file}, 실행 중인 값은 ${r.live}`).join(" / ")} — 이 키는 앱을 다시 켜야 바뀌어요.`,
      );
    }
    // 키 단위가 아니라 모드 자체를 비교한다. refreshEnv는 파일에서 **사라진** restart-only 키를 보고하지 않으므로,
    // DEBUG_EXTERNAL_DATABASE_URL을 지워 내장 모드로 돌아가려는 사람에게 아무 말도 하지 않는다 (외부 리뷰 #5).
    if (!sameMode(cfg.databaseMode, live.mode) || cfg.env.STORAGE_ROOT !== live.env.STORAGE_ROOT) {
      notices.push(
        `데이터베이스가 파일에서는 ${describeMode(cfg.databaseMode)}(파일 저장소 ${cfg.env.STORAGE_ROOT}), 실행 중에는 ${describeMode(live.mode)}(파일 저장소 ${live.env.STORAGE_ROOT})예요 — 앱을 다시 켜야 바뀌어요.`,
      );
    }
    if (notices.length === 0) {
      // 리셋이 빠지면 어긋남이 풀렸다가 **같은 모양으로** 다시 났을 때 두 번째를 아무도
      // 적지 않고 아무도 말하지 않는다 — 로그도 대화상자도 첫 번째로 끝난다.
      lastNotice = "";
      return { notice: null, isNew: false };
    }
    const notice = notices.join(" / ");
    // `lastNotice === ""`가 아니라 `notice !== lastNotice`다. 어긋난 키가 하나에서 둘로 늘거나
    // 값이 바뀌면 그것은 **새 내용**이고, 로그도 대화상자도 그것을 다시 말해야 한다.
    const isNew = notice !== lastNotice;
    if (isNew) {
      lastNotice = notice;
      deps.log(notice);
    }
    return { notice, isNew };
  };
}
