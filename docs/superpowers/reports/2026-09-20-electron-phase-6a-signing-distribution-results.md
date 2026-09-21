# Electron Phase 6a — Task 10: packaged 통합 검증 결과

작업 디렉터리: `desktop/`. 대상 `.app`: `desktop/out/mac-arm64/Damwha.app`.
브리프: `.superpowers/sdd/2026-09-20-electron-phase-6a-signing-distribution/task-10-brief.md`.

## 0. 재패키징 증거

Task 1~9 끝에서 `desktop/out/`이 `dfd6c1a`(Task 6 중간) 산출물이었고, 그 뒤 커밋
(`847e2dd`·`ad108df`·`f84d52c`·`ecdbf41`·`9ae6e63`·`a368f12`)이 번들에 들어 있지
않았다. 재패키징부터 했다.

```bash
cd desktop
rm -rf out
pnpm run package:desktop > /tmp/t10-package.out 2>&1   # 백그라운드, --release 없음(공증 재제출 안 함)
```

- 재패키징 당시 HEAD: `a368f128b7f7860ca688cc2e49633578fbfe3a1b`(작업 시작 시 git status 그대로, clean).
- `.app` 디렉터리 mtime: `Sep 21 13:21:11 2026`(빌드 시작 13:17 ~ 완료 13:26, 소요 약 9분).
- `check-bundle.mjs`가 `package.mjs` 안에서 함께 돌았다(39개 PASS, 0 FAIL):

```
$ node scripts/check-bundle.mjs
... (39줄)
PASS  every Mach-O in the postgres tree carries hardened runtime — 66/66 flags=…(runtime)
PASS  every signed arm64 Mach-O in the python and ffmpeg trees carries hardened runtime — 454/454 flags=…(runtime)
PASS  no __pycache__ under Resources/python — 0
PASS  every script in Resources/python/bin has a bundle-relative shebang
      (64 console script(s) checked)
PASS  every Mach-O in the bundle targets macOS 15.0 or lower

Bundle hygiene: all checks passed.
```

**번들이 T7·T8·T9를 실제로 담고 있다는 근거(직접 확인, 소스가 아니라 산출물):**

| 조각 | 번들 안 경로 | 확인 |
| --- | --- | --- |
| T7 (worker 디스크 점검) | `Contents/Resources/python/lib/python3.12/site-packages/damwha_worker/models/disk.py` | `diff`로 저장소의 `be/worker/damwha_worker/models/disk.py`와 **바이트 단위 동일** 확인 |
| T8 (API 507 필터) | `Contents/Resources/api/dist/storage/disk-full.filter.js` | 컴파일된 JS에 `rmSync`(임시 파일 정리)·`freeBytes`·`DISK_FULL` 셋 다 존재 확인 |
| T9 (화면 문구) | `Contents/Resources/api/dist/public/assets/demo-read-only-*.js`(fe SPA), `app.asar`의 `dist/diagnostics/causes.js`(데스크톱 메인) | fe 번들에 `DISK_FULL` 문자열 존재, `causes.js`에 `디스크 공간이 부족해요` 정규식과 문구 템플릿 존재 확인 |

`app.asar`는 `desktop/node_modules/.bin/asar`로 열었다(`list`/`extract-file`).

## 1. 브리프의 검증 항목별 결과

### Step 1 — 업로드 ENOSPC 주입 실증

```bash
hdiutil create -size 20m -fs APFS -volname DamwhaTiny -type SPARSE tiny.sparseimage
hdiutil attach tiny.sparseimage -mountpoint /Volumes/DamwhaTiny   # ~19MB 여유
APP=desktop/out/mac-arm64/Damwha.app
TMPDIR=/Volumes/DamwhaTiny "$APP/Contents/MacOS/Damwha" &   # open 대신 실행 파일 직접 호출
```

**첫 시도가 틀렸다 — 그리고 잡아냈다.** 최초 `curl -X POST http://127.0.0.1:3000/api/meetings`는
패키지된 앱이 아니라 포트 3000에 떠 있던 **무관한 `pnpm be:dev` 서버**(`node be/dist/main`,
`nest start --watch`)를 쳤다. `lsof -iTCP:3000`으로 발견 — 패키지된 앱은 3000이 이미 점유돼
있어 자동으로 다른 포트(`62798`)를 골랐다. 그 첫 시도가 실 개발 DB(`localhost:5432`)와
`be/storage`에 `mtg_40`을 만들었으므로 **즉시 되돌렸다**(§4 "실수와 정정" 참고). 이후
`lsof -iTCP -sTCP:LISTEN | grep Damwha`로 패키지된 앱의 실제 포트를 확인하고 그 포트로 다시 했다.

25MB 무작위 바이트 파일을 그 포트로 업로드:

```
HTTP_STATUS:507
{"code":"DISK_FULL","free":20250624,"needed":null}
```

`api.log`:
```
[Nest] 17674  - 09/21/2026, 1:36:47 PM   ERROR [HTTP] POST /api/meetings 500 86ms — ENOSPC: no space left on device, write
[Nest] 17674  - 09/21/2026, 1:36:47 PM   ERROR [DiskFullFilter] 업로드 중 디스크가 찼다 — 남은 용량 20250624 바이트
```

**판정: 통과.** `TMPDIR`이 `ps eww <api pid>`로 확인한 대로 API 자식(`utilityProcess.fork`)까지
그대로 상속됐고(`api-process.ts`의 `apiChildEnv`가 의도적으로 상속 env를 깐다), multer의
`os.tmpdir()`가 그 값을 따랐다. `os.tmpdir()`가 `TMPDIR`을 따른다는 브리프의 전제가 실측으로
확인됐다.

화면(`디스크 공간이 부족해요 — 남은 용량 …`) 자체는 **GUI 상호작용 권한이 없어 렌더링을 직접
보지 못했다** — API 응답이 `fe/src/shared/api/client.ts`의 `diskFullMessage(free, needed)`가
소비하는 정확한 모양(`{code:'DISK_FULL', free:20250624, needed:null}`)이라는 것만 소스 대조로
확인했다.

### Step 2 — 업로드 실패가 아무것도 안 남겼는지 (P6a-C7)

```bash
UD="$HOME/Library/Application Support/Damwha"
PSQL="$APP/Contents/Resources/postgres/bin/psql"
"$PSQL" -h "$UD/run" -U damwha damwha -c "select count(*) as new_meetings from meeting where created_at > now() - interval '5 minutes';"
"$PSQL" -h "$UD/run" -U damwha damwha -c "select count(*) as new_jobs from job where created_at > now() - interval '5 minutes';"
find /Volumes/DamwhaTiny -iname "dw-upload-*"
```

결과: `new_meetings=0`, `new_jobs=0`, 임시 파일 0개, 전체 `meeting`/`job` 행 수가 시도 전(11/65)과
동일. **판정: 통과.**

### Step 3 — 모델 다운로드 디스크 부족 재현 (P6a-C6·C8b), 주체 셋

**주입 방법.** `HF_HUB_CACHE` 환경변수 오버라이드는 **먹히지 않는다** — `desktop/src/config/config.ts`의
`STRIPPED_CHILD_ENV_KEYS`가 상속 env에서 `HF_HUB_CACHE`(+`TRANSFORMERS_CACHE`·`TORCH_HOME`·
`XDG_CACHE_HOME`)를 명시적으로 지운다("HF_HOME 하나가 모두를 이긴다"). `HF_HOME`도 마찬가지로
`appOwnedChildEnv`가 `<userData>/models`로 강제 고정해 env로 못 바꾼다. 그래서 **파일시스템
레벨로 캐시 자체를 옮겼다** — 브리프가 예시한 "HF 캐시를 작은 볼륨에 둔다" 그대로:

```bash
# 앱 정지 상태에서
mv "$UD/models" "$UD/models.real-backup"          # 실 캐시(8.8GB) 대피
ln -s /Volumes/DamwhaHFTiny "$UD/models"           # 8MB sparse volume(~7.6MB 여유)로 심볼릭 링크
```

**주체 1 — embed 기동.** 앱을 다시 띄우자 embed가 즉시 실패했다:

```
damwha_worker.errors.WorkerError: DISK_FULL: 디스크 공간이 부족해요 — 남은 용량 8.0 MB, 필요한 용량 5.5 GB.
```
`supervisor.log`:
```
embed: 기동 실패 — 3초 뒤 재시작 (1회차)
embed: 기동 실패 — 8초 뒤 재시작 (2회차)
embed: 기동 실패 — 20초 뒤 재시작 (3회차)
embed: 재시작 상한 3회를 넘겼다 — 수동 재시도를 기다린다
```
상한 있는 backoff 뒤 수동 재시도 대기로 정상 수렴. **PERMANENT 성격의 실패가 무한 재시작을
돌지 않는다** — 이 자체가 P6a-C8b의 정신(재시도 예산 보존)을 서비스 기동 경로에서도 지킨다는
방증.

**주체 2 — worker job(회의 카드).** 3초짜리 유효 WAV(`ffmpeg -f lavfi sine=440 -t 3`)를
같은 포트로 업로드(`mtg_109`/`job_198`). `pyannote/speaker-diarization-community-1`(gated
diarization 모델)이 캐시 미스로 실제 HF 메타데이터를 조회(`GET …?blobs=true → 200 OK`,
네트워크 접근은 됐다)한 뒤 디스크 부족으로 던졌다:

```sql
select id, status, attempts, max_attempts, next_attempt_at, error->>'code' as code, error->>'message' as msg
from job where id='job_198';
-- job_198 | failed | 1 | 5 | (null) | DISK_FULL | 디스크 공간이 부족해요 — 남은 용량 8.0 MB, 필요한 용량 40.4 MB.
select id, status, error->>'code' from meeting where id='mtg_109';
-- mtg_109 | failed | DISK_FULL
```
`worker.log`: `WARNING: job job_198 type=process_meeting failed: code=DISK_FULL kind=PERMANENT attempt=1/5`.
**판정: 통과.** job·meeting 둘 다 즉시 `failed`, `DISK_FULL`로 정직하게 표시.

**주체 3 — LLM 기동(상태 창).** 기존 `done` 회의(`mtg_107`, 이번 세션 이전부터 있던 테스트
데이터)에 `POST /api/meetings/mtg_107/summary/generate`로 수동 요약 재생성을 걸어 LLM 기동
경로를 탔다(`job_199`, type=`summarize_meeting`). `mlx_lm.server`가 뜨고 `/v1/models`
준비 프로브는 200으로 통과했지만(모델을 실제로 물지 않고도 응답 가능), 실제 채팅 요청이
지연 로드를 트리거하자:

```
Exception in thread Thread-1 (_generate):
...
damwha_worker.errors.WorkerError: DISK_FULL: 디스크 공간이 부족해요 — 남은 용량 8.0 MB, 필요한 용량 6.2 GB.
```

**이 예외가 job에 도달하지 않는다.** `mlx_lm.server`의 요청 처리 스레드(`Thread-1
(_generate)`) 안에서 일어나 Python 기본 스레드 예외 훅이 stderr에 찍기만 하고 삼킨다 — 그
스레드가 응답을 만들지 못한 채 조용히 죽는다. `summary_client.py`의 `httpx.Client`는
그 요청을 그냥 계속 기다리다가 `lens_llm_timeout_seconds`(기본 300초) 뒤에야 포기했다:

```
elapsed_ms=300014
job job_199 type=summarize_meeting failed: code=llm_request_failed kind=PERMANENT attempt=1/5
```

```sql
select error->>'code', error->>'message' from job where id='job_199';
-- llm_request_failed | timed out
```

**판정: 부분 충족.** 최종적으로 `attempts=1/5`, `status='failed'`, PERMANENT로 재시도 예산은
안 태웠다(Step 4의 요구는 만족) — 하지만 사용자가 보는 오류는 `DISK_FULL`이 아니라
`llm_request_failed`/"timed out"이고, 그 판정까지 **5분을 그대로 기다려야** 한다. 디스크
부족이 LLM 기동 경로에서는 정직하게 표면화되지 않는다. 아래 "우려"에 다시 적는다 — **이
Task는 관찰만 하고 고치지 않았다**(범위 밖).

**P6a-C12(토큰) 부수 관찰.** 이 세 시도 전부에서 HF 토큰 재입력 대화상자나 `supervisor.log`의
토큰 관련 줄이 **전혀 없었다**(`grep -n "토큰\|token"`의 마지막 줄은 9/17~9/20의 옛 항목뿐).
특히 주체 2에서 gated 모델(`pyannote/speaker-diarization-community-1`)의 메타데이터 조회가
토큰 없이는 401이 났을 텐데 `200 OK`로 통과했다 — 즉 **키체인에 저장된 토큰이 Developer ID
서명 아래서, 그리고 실제 gated 모델 인증이 걸리는 경로에서 재입력 없이 작동**했다. Task 5의
"왜 그런지 모른다"는 여전히 미해명이지만, 이번 Task는 그 정지 이후 **처음으로 토큰이 실제
gated-repo 인증에 쓰이는 경로를 탄** 사례를 하나 더 보탰다.

### Step 4 — 재시도 예산을 안 태웠는지 (P6a-C8b)

Step 3의 세 job이 그대로 증거다:

```sql
select id, status, attempts, max_attempts, error->>'code' from job where id in ('job_198','job_199') order by id;
--  job_198 | failed | 1 | 5 | DISK_FULL
--  job_199 | failed | 1 | 5 | llm_request_failed
```

둘 다 `attempts`가 1에 그쳤고 `status='failed'`, `next_attempt_at`이 없다(`queued`로 돌아
백오프를 돈 적이 없다). **판정: 통과** — `job_198`(worker job, DISK_FULL로 직접)과
`job_199`(LLM, 5분 타임아웃을 거쳐서지만 결국 PERMANENT 1회)에서 공통으로 확인.

### Step 5 — 데이터 보존과 정합성 (P6a-C8, Phase 5의 정합성 질의 넷)

`WORKER_ID`는 `worker.log`의 마지막 `ready (db connected)` 줄에서 읽었다
(`desktop-9c144237-3ee5-4a7f-8355-c83989b39899` — `ps`의 `--run-id`와 다른 값이라는 desktop/CLAUDE.md의
경고 그대로였다).

전체 카오스(ENOSPC 업로드 실패, embed 3회 재시작 상한, worker job DISK_FULL, LLM 5분 타임아웃)
**뒤**에 Phase 5 §11의 그 넷을 그대로 돌렸다:

```sql
SELECT count(*) FROM meeting m JOIN job j ON j.id=m.current_job_id
 WHERE m.status='processing' AND j.status NOT IN ('running','queued');        -- 0
SELECT count(*) FROM job WHERE status='running' AND locked_by IS NULL;         -- 0
SELECT count(*) FROM meeting m JOIN job j ON j.id=m.current_job_id
 WHERE m.status='done' AND j.status <> 'done';                                 -- 0
SELECT count(*) FROM job WHERE status='running' AND locked_by LIKE 'desktop-%'
   AND locked_by <> 'desktop-9c144237-3ee5-4a7f-8355-c83989b39899';            -- 0
```

넷 다 0. **판정: 통과.**

기존 데이터 대조: 시도 전 `meeting=11, job=65, utterance=127`. Step1/2(ENOSPC 업로드 거부)는
아무 행도 안 남겼다(위 확인). Step3에서 **의도적으로** 만든 정상 행 — `mtg_109`/`job_198`(업로드
성공 후 모델 로드 단계에서 정직하게 실패), `job_199`(기존 `mtg_107`에 붙인 요약 재시도) — 는
"정합성 위반"이 아니라 이 Task가 직접 유발한 정상적인 실패 기록이다. `mtg_107`의 `status`는
재시도 전후로 `done` 그대로였다(위 §Step3). `utterance` 수는 불변(127) — `job_198`이 STT
이전 단계(diarization 모델 로드)에서 죽었으므로 부분 `utterance`가 남지 않은 것과 일치.

### Step 6 — 정리

```bash
hdiutil detach -force /Volumes/DamwhaTiny      # "disk4" ejected
hdiutil detach -force /Volumes/DamwhaHFTiny    # "disk6" ejected
rm -f tiny.sparseimage hftiny.sparseimage
```

- `/Volumes/`에 Damwha 볼륨 없음, `diskutil list`에도 없음 확인.
- `models` 심볼릭 링크를 지우고 `models.real-backup`(8.8GB)을 `models`로 되돌림 — `du -sh`로
  8.8G 그대로 확인.
- 앱을 한 번 더 정상 기동해(env 개입 없이) embed가 실 8.8GB 캐시로 다시 `준비됨`까지 가는 것을
  확인한 뒤(`Loading weights: 100%` 즉시 완료, `POST /embed 200 OK`) 정상 종료.
- `Damwha.app/Contents/MacOS/Damwha`는 매번 `kill`(SIGTERM)로 정지했고 그때마다
  `SingletonLock` 없이 깨끗이 종료(`ps aux | grep -i damwha` 빈 결과) 확인.
- `Contents/Resources/python` 아래 `__pycache__` 0개 — 이 세션 내내 앱이 자기 스스로 띄운
  python 프로세스만 썼고(정상 동작 경로, `PYTHONPYCACHEPREFIX=<userData>/pycache`가 봉인 밖으로
  돌린다), 검증자가 번들 python을 직접 호출한 적은 없다.

### 실수와 정정 — 포트 3000 오인 (기록으로 남긴다)

Step 1의 첫 시도가 패키지된 앱이 아니라 `pnpm be:dev`(포트 3000, 실 개발 DB·`be/storage`)를
쳤다. `mtg_40`(25MB 무작위 파일, `job_222`)이 그쪽에 생겼다는 것을 `lsof`로 발견한 즉시:

```sql
delete from meeting where id='mtg_40';   -- DELETE 1
delete from job where id='job_222';      -- DELETE 0 (이미 cascade)
```
```bash
rm -rf be/storage/meetings/mtg_40
```
둘 다 0행으로 되돌아온 것을 확인했다. 그 뒤로는 `lsof -nP -iTCP -sTCP:LISTEN | grep Damwha`로
패키지된 앱의 실제 포트(매 기동마다 다름 — 3000이 점유돼 있어 앱이 빈 포트로 물러난다)를
먼저 확인하고서만 요청을 보냈다.

## 2. 이월 항목 셋 — 관찰 결과

1. **P6a-C12(HF 토큰).** 위 Step 3 참고. **관찰함.** 세 번의 모델-로드 시도(embed, worker job의
   gated pyannote, LLM의 Qwen) 전부에서 토큰 재입력 대화상자가 뜨지 않았고, gated 모델
   메타데이터 조회가 인증 없이는 불가능한데 200 OK로 성공했다 — 키체인 토큰이 여전히 조용히
   작동한다는 것을 이번에도 확인했다. **왜** 무효화되지 않는지는 여전히 미해명 — 이 Task의
   범위가 아니다.
2. **훅 설치 성공 여부.** **관찰함.** 세 로그 전부에서 `hf download progress hook installed
   (writer=…, rebound=…)`(embed) 또는 그 뒤를 잇는 실제 `check_free_space` 호출·예외 스택(worker
   job·LLM)이 나타났다 — `_install`이 이번 재패키징 뒤 실제 packaged 실행에서 **매번 성공**했고,
   디스크 점검이 조용히 함께 멈추는 구조적 위험(브리프가 지목한 "같은 클로저 안이라…")이
   **이번 세 회차에서는 발현하지 않았다**. 다만 이것이 "_install이 실패할 수 없다"는 증명은
   아니다 — 세 회차 모두 정상 설치 경로만 실측했을 뿐, `_install` 실패를 인위로 유발해 롤백까지
   보지는 않았다(그건 이 Task의 범위 밖이다).
3. **`-1` 센티널.** **관찰 못 했다.** `be/src/storage/disk-full.filter.ts`의 `freeBytes()`는
   `fs.statfsSync(dir)`가 던질 때만 `-1`을 낸다 — 이번 Step 1 재현에서 `os.tmpdir()`은 항상
   유효한 마운트 지점(`/Volumes/DamwhaTiny`)이었으므로 `statfsSync`가 매번 성공했고(응답의
   `free:20250624`가 그 증거), `-1` 경로는 밟히지 않았다. 그 경로를 밟으려면 `os.tmpdir()`
   자체가 stat 불가능한 상태(예: 마운트가 검증 도중 예기치 않게 빠짐)가 되어야 하는데, 이는
   디스크 이미지를 예측 불가능하게 만드는 것이라 이 Task에서 인위로 시도하지 않았다. **고치라는
   요청도 없었고 고치지 않았다** — 범위 밖, 최종 리뷰가 판정한다.

## 3. 바뀐 파일

없음. 이 Task는 검증 전용이며 코드를 수정하지 않았다(`git status --short`가 작업 종료 시
비어 있음을 확인). 재패키징 산출물(`desktop/out/`)은 gitignore 대상이라 커밋 대상이 아니다.

## 4. 자기 리뷰에서 찾은 것

- **완전성.** 브리프의 Step 1~7을 전부 수행했다. Step 3의 "주체 셋"을 각각 실제 앱 경로로
  관찰했다(embed는 정상 기동 경로 재사용, worker job은 실제 업로드→claim→모델 로드, LLM은
  `POST /summary/generate`로 실제 job 큐를 태웠다 — 단위 테스트로 대체하지 않았다). 세 이월
  항목도 모두 손을 댔고, 하나는 정직하게 "못 했다"로 남겼다.
- **정직성.** Step 1의 화면 렌더링 자체는 GUI 권한이 없어 못 봤다고 명시했다. Step 3의 LLM
  주체는 "판정: 부분 충족"으로 적었다 — DISK_FULL이 아니라 타임아웃으로 새는 것을 숨기지
  않았다. 포트 3000 오인 실수와 그 정정 과정을 감췄다면 더 깔끔해 보였겠지만, 실 개발
  DB·스토리지를 건드렸던 사실이라 남겼다.
- **규율.** 태그·릴리스에 손대지 않았다(`git tag`·`gh release` 호출 없음). `--release`를
  쓰지 않아 공증을 다시 제출하지 않았다. `causes.ts`의 사유 문구를 새로 짓지 않았고, 발견한
  두 구조적 문제(LLM 경로의 타임아웃 새기, `-1` 센티널)를 **고치지 않고** 관찰만 남겼다.
  실 디스크는 채우지 않았고 격리된 sparse image만 썼다 — 끝에 detach·삭제 확인했다. 번들
  python을 검증자가 직접 실행한 적은 없다(check-bundle의 `__pycache__` 0건이 그 증거).
  `desktop/out`을 다시 `rm -rf`하지 않았다(이미 브리프 요구 이상이라 판단, 산출물은 그대로
  둬 다음 Task가 재사용할 수 있게 했다).
- **찾아서 고친 것.** 작업 중 `desktop/causes.js`가 저장소 루트 바로 아래 실수로 추출돼
  `git status`에 걸렸다 — 즉시 지우고 `git status --short`가 빈 것을 재확인했다. 포트 3000
  오인으로 오염된 실 개발 DB·`be/storage`도 즉시 원복했다(위 "실수와 정정").

## 5. 우려

1. ~~**LLM 기동 경로의 디스크 부족이 사용자에게 거짓 신호를 준다.**~~ **해소됨 (Ruling R16,
   fix round, 아래 §6).** `mlx_lm.server`의 지연 로드가 요청 스레드 안에서 일어나
   `check_free_space`의 `WorkerError(DISK_FULL, …)`가 그 스레드 안에서 죽고 절대 job에
   도달하지 않던 문제 — `run_guarding_disk_full`(`be/worker/damwha_worker/llm_server.py`)이
   서버 stderr를 감시해 그 서명을 잡으면 5분을 기다리지 않고 그 자리에서 같은 사유로 job을
   실패시키도록 고쳤다. `extract_lenses`·`summarize_meeting` 두 LLM job type 모두. 실측
   증거는 `.superpowers/sdd/2026-09-20-electron-phase-6a-signing-distribution/task-10-report.md`
   §4 — 격리된 testcontainer DB + 격리된 10MB volume + 실제 `mlx_lm.server`로 4.88초 만에
   `DISK_FULL`로 실패하는 것을 확인했다(원래는 5분 뒤 `llm_request_failed`였다).
2. **`-1` 센티널은 이번에도 실측하지 못했다.** Task 9 리뷰가 넘긴 그대로 미해결 — 재현하려면
   `os.tmpdir()`이 stat 불가능해지는 조건을 인위로 만들어야 하는데, 이는 디스크 이미지를 예측
   불가능한 상태로 만드는 것이라 이 Task의 "실제 디스크를 채우지 않는다"는 안전 수칙과 결이
   비슷해 시도하지 않았다.
3. **포트 3000 충돌은 이 환경에 국한된 우연이 아닐 수 있다.** 개발자 셸에 `pnpm be:dev`가 떠
   있는 상태에서 패키지된 앱을 띄우면 앱이 조용히 다른 포트로 물러난다(오류 없이) — 이번처럼
   검증자가 `lsof`로 확인하지 않으면 엉뚱한 서버를 테스트하고도 "통과"로 착각하기 쉽다. 이
   자체가 버그는 아니지만(포트 충돌 시 대체 포트로 물러나는 것은 의도된 동작으로 보인다),
   검증 절차 문서에 "먼저 실제 포트를 lsof로 확인하라"는 한 줄을 넣을 가치가 있어 보인다.

## 6. Fix round (Ruling R16) — 우려 1 해소

사용자 승인(Ruling R16, "Phase 6a 안에서 고친다")에 따라 위 우려 1을 같은 Task 10 작업
안에서 고쳤다. 전체 배선·RED/GREEN·실측 증거·자기 리뷰는
`.superpowers/sdd/2026-09-20-electron-phase-6a-signing-distribution/task-10-report.md`에
있다. 요지:

- `be/worker/damwha_worker/llm_server.py`의 `run_guarding_disk_full(proc, fn)`(전 라운드가
  구현, 이번 라운드가 배선)가 워커가 띄운 LLM 서버의 stderr에서
  `damwha_worker.errors.WorkerError: DISK_FULL: ` 서명을 감시해, 보이면 `fn`(LLM 클라이언트의
  블로킹 호출)의 완료를 기다리지 않고 그 자리에서 같은 사유로 실패시킨다. DISK_FULL만 좁게
  잡는다 — 다른 오류(타임아웃·연결 오류 등)는 기존 경로 그대로.
- `jobs.py`의 `ExtractLensesHandler`·`SummarizeMeetingHandler` 둘 다 — 완전성 확인 결과 두
  handler 모두 같은 `managed_llm_server`/`mlx_lm.server` 경로를 공유했다.
- 격리 testcontainer DB + 격리 10MB HF 캐시 volume + 실제 `mlx_lm.server` 서브프로세스로
  실측: 5분(`lens_llm_timeout_seconds`) 대신 **4.88초**, `llm_request_failed`/"timed out"
  대신 **`DISK_FULL`**로 job이 실패하는 것을 확인.
- worker 테스트 전체 708 passed(회귀 없음), ruff 클린.
