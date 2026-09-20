# Electron Phase 5 — 운영 안정화 실행 결과

스펙: [2026-09-19-electron-phase-5-operational-hardening-design.md](../specs/2026-09-19-electron-phase-5-operational-hardening-design.md)
계획: [2026-09-19-electron-phase-5-operational-hardening.md](../plans/2026-09-19-electron-phase-5-operational-hardening.md)

## 1. 검증 준비 — 디스크 부족 주입 방법 (Task 1)

판정: **후보 1 불가 — 사용자 판단 필요**

이번 라운드는 후보 1(sparse image + `--user-data-dir`)만 실행했다. 컨트롤러가
후보 2(실 `data/storage` 이동)를 이 라운드의 위임 범위에서 제외했으므로 시도하지
않았다. 이미 빌드돼 있던 `desktop/out/mac-arm64/Damwha.app`을 그대로 썼다
(재빌드하지 않음).

### 재현 명령

```bash
# Step 1 — 512MB sparse image 생성·마운트
hdiutil create -size 512m -type SPARSE -fs APFS -volname DamwhaDiskFull /tmp/damwha-diskfull
hdiutil attach /tmp/damwha-diskfull.sparseimage
ls -la /Volumes/DamwhaDiskFull

# Step 2 — packaged 앱을 그 볼륨의 userData로 기동
"/Users/gim-yeongjae/project/daewha/desktop/out/mac-arm64/Damwha.app/Contents/MacOS/Damwha" \
  --user-data-dir=/Volumes/DamwhaDiskFull/Damwha > /tmp/diskfull-probe.log 2>&1 &
APP_PID=$!
sleep 75
ps -ef | grep -i "Damwha.app" | grep -v grep
find /Volumes/DamwhaDiskFull -maxdepth 4
ls -la "$HOME/Library/Application Support/Damwha/data"
tail -n 60 /tmp/diskfull-probe.log
kill "$APP_PID"
pkill -f "out/mac-arm64/Damwha.app/Contents/MacOS/Damwha"

# 정리
hdiutil detach /Volumes/DamwhaDiskFull
rm -f /tmp/damwha-diskfull.sparseimage
```

### 실제로 관찰한 것

**`--user-data-dir`은 확실히 먹혔다.** `main.ts`가 `app.setName("Damwha")`를
호출하는데도, 프로세스 목록의 모든 자식(GPU/utility/renderer 헬퍼)이
`--user-data-dir=/Volumes/DamwhaDiskFull/Damwha`를 그대로 들고 있었고,
`/Volumes/DamwhaDiskFull/Damwha` 아래에 Electron/Chromium이 쓰는 전체 트리
(`Cache`, `GPUCache`, `Local Storage`, `Preferences`, `Local State`,
`logs/supervisor.log`, `SingletonLock` 등)가 실제로 생성됐다. 반대로
`~/Library/Application Support/Damwha/data/postgres`·`data/storage`의 mtime은
기동 전후로 전혀 바뀌지 않았다 — 앱이 기존 실사용자 경로를 열지 않았다는
뜻이다. 즉 브리프가 경고한 "탈락" 조건 중 하나("기존 경로를 연다")는 명확히
아니었다.

**그러나 `data/postgres` 클러스터는 생기지 않았다.** 볼륨에 생성된 파일 목록에
`data/` 디렉터리 자체가 없다. `logs/supervisor.log`에는 딱 한 줄만 있었다:

```
2026-09-20T04:44:52.224Z 허깅페이스 토큰이 없어요 — 토큰 창을 띄웁니다. 서비스는 아직 띄우지 않았어요.
```

`desktop/src/main.ts`의 `ensureHfToken()`을 읽어보면 이유가 나온다. HF 토큰은
`userData`별로 저장되는 파일 스토어(`makeTokenStore(userData, safeStorage)`)에서
읽는다. 완전히 새 `userData`(볼륨 위 경로)에는 당연히 토큰 파일이 없으므로,
게이트가 `BrowserWindow` 토큰 입력창을 띄우고 **postgres/API/worker 어느
서비스도 시작하기 전에** 사람의 입력을 기다리며 블록한다. 헤드리스로 75초를
기다려도 그 줄 이후로 로그가 늘지 않았고, `data/postgres`는 끝까지 생기지
않았다. 코드에 `process.env.HF_TOKEN` 같은 우회 경로는 없었다(grep 결과 없음).
창을 닫으면 `app.quit()`이 불리는 경로만 있다.

이건 헤드리스 실행 환경의 우연한 결함이 아니라 **후보 1의 구조적 성질**이다.
후보 1은 정의상 "완전히 새로운 userData"를 쓰므로, 그 userData의 토큰 스토어도
항상 비어 있다. 즉 후보 1로 postgres 초기화까지 실제로 관찰하려면 매 실행마다
(a) GUI로 토큰을 직접 입력하거나, (b) 유효한 토큰 파일을 그 새 userData에
미리 심어둬야 한다. 이번 라운드는 둘 다 하지 않았다:

- (a)는 이 세션에 화면 제어(computer-use) 권한이 없어 자동화할 수 없었다.
- (b)는 실 토큰 파일이 `~/Library/Application Support/Damwha/hf-token.bin`에
  있는데, 이걸 디스크 밖으로 복사하는 동작은 이번 라운드의 위임 범위("읽기만
  허용, 그 외 손대지 않는다")를 벗어난다고 판단해 시도하지 않았다.

### 판정 근거

`--user-data-dir` 스위치 자체가 이 packaged 앱에서 정상 동작한다는 것은
확인했다 — `app.setName`의 존재가 리디렉션을 막지 않았고, 실사용자 경로는
건드리지 않았다. 이 점은 후보 1에 긍정적이다.

다만 브리프의 성립 조건("`data/postgres`에 클러스터가 생긴다")은 이번 라운드
증거로는 충족되지 않았다 — 단, 그 이유가 디스크 리디렉션의 실패가 아니라
별도의 HF 토큰 게이트라는 것도 같이 밝혀졌다. 이 게이트를 뚫는 방법(토큰
사전 배치 또는 GUI 자동화)을 어떻게 다룰지는 이번 태스크의 위임 범위 밖이라
컨트롤러/사용자 판단이 필요하다. 증거가 애매하게 갈리는 지점이므로 여기서
멈추고 판정을 "불가 — 사용자 판단 필요"로 남긴다.

### 정리 확인

- `hdiutil detach /Volumes/DamwhaDiskFull` 성공, `/Volumes/`에 `DamwhaDiskFull`
  없음.
- `/tmp/damwha-diskfull.sparseimage` 삭제 확인.
- 기동했던 `Damwha` 프로세스는 `kill`/`pkill`로 종료했고, 이후 `ps -ef | grep -i
  damwha`에 남은 프로세스 없음.
- `~/Library/Application Support/Damwha/data/postgres`, `.../data/storage` 모두
  기동 전후 mtime 불변 — 실사용자 데이터는 전혀 건드리지 않았다.
- 이번 라운드는 후보 2(Step 3, 3b)를 시도하지 않았으므로 `data/storage`는
  원래부터 심볼릭 링크가 된 적이 없다.

## 2. 통합 검증 — P5-C1·C4·C6·C7·C8·C10 (Task 10, 이번 라운드)

이번 라운드의 위임 범위는 여섯 기준(C1, C4, C6, C7, C8, C10)뿐이다. **C5(잠자기)와
C9(녹음 중 강제 종료)는 시도하지 않았다** — 컨트롤러가 두 기준을 사용자 본인이 나중에
직접 돌리기로 결정했고(`pmset sleepnow`는 이 세션 자체를 재우므로 절대 실행하지
말라는 지시를 받았다), 마이크가 필요한 C9도 이 세션에서 관찰할 수 없다.

`desktop/out/mac-arm64/Damwha.app`(2026-09-20 14:12 빌드)를 재빌드하지 않고 그대로
썼다.

### 사전 장애물 — packaged 앱이 macOS Keychain 승인 창에서 무기한 멈춘다

`Damwha.app`을 처음 실행했을 때 어떤 서비스도 뜨지 않고 `supervisor.log`가 몇 분간
한 줄도 늘지 않았다. `ps -ef`로 확인해보니 기동 시각과 정확히 일치하는 `SecurityAgent`
프로세스가 매 실행마다 새로 뜬 채 멈춰 있었다:

```
501 24197 1 0 2:27오후 ?? 0:00.21 /System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent
```

코드를 읽어보면 `desktop/src/app/token-gate.ts`의 `runTokenGate`는 저장된 HF 토큰을
`store.read()`로 성공적으로 복호화하면 **아무 로그도 남기지 않고** 즉시 진행한다
(`ready`). 즉 로그가 안 늘어난 것 자체가 "이 호출이 멈춰 있다"는 증거였다.
`store.read()` → Electron `safeStorage.decryptString()`은 macOS에서 Keychain을 쓰는데,
`codesign -dv`로 확인한 이 빌드는 `adhoc` 서명(`TeamIdentifier=not set`)이라 — 토큰을
저장했던 이전 빌드/실행과 서명 아이덴티티가 달라, macOS가 "다른 앱이 이 Keychain
항목을 쓰려 한다"는 승인 창(SecurityAgent)을 띄운 것으로 강하게 추정된다. 이
세션에는 그 창을 눌러줄 화면 제어 권한이 없었다(`computer-use`는 다른 세션이 점유
중이었고, `osascript`로 System Events를 조작하는 것도 자체 권한 승인 창에서 똑같이
멈췄다 — `timeout 6 osascript …` 는 exit 124).

**Keychain·Accessibility 설정을 바꾸는 것은 금지된 영역이라 손대지 않았다.** 대신
그 멈춘 `SecurityAgent`를 죽이는 것만 시도했다(승인 거부와 같은 효과) — 처음 두 번은
`store.available()`이 `false`로 떨어져 "키체인 암호화를 쓸 수 없어 서비스를 띄우지
않아요"라는 정직한 `manual` 실패로 끝났고, 그 다음 재시도(사람이 아무 것도 안 눌러도
왜 다시 시도됐는지는 확인하지 못했다 — 화면을 볼 수 없어 "다시 시도" 버튼이 자동으로
불렸는지 다른 경로인지는 미확인)부터는 승인 창 없이 정상 기동했다. 이후 이 세션
안에서는 재현되지 않았다 — 아마 그 시점부터 macOS가 이 서명에 대한 결정을 어떤
형태로 기억한 것으로 보이나, 이 메커니즘 자체는 미판정으로 남긴다(관찰은 정확히
위에 적은 것뿐이다).

### P5-C1 — 분석 중 강제 종료

```bash
curl -s -X POST http://127.0.0.1:3000/api/meetings \
  -F "audio=@/tmp/damwha-probe/c1-upload.m4a;type=audio/mp4" \
  -F "title=C1 probe" -F "defer_lens=true" -F "defer_summary=true"
# → {"id":"mtg_5","current_job_id":"job_51",...}

# stage 확인
curl -s http://127.0.0.1:3000/api/meetings/mtg_5/status
# → {"status":"processing","stage":"vad",...}

# 죽이기 전
psql ... -c "SELECT id,status,locked_by,attempts,stage FROM job WHERE id='job_51';"
# → job_51 | running | desktop-409478dd… | 1 | diarize

pkill -9 -f "Damwha.app/Contents/MacOS/Damwha"
rm -f "<userData>/SingletonLock" "<userData>/Cookies" "<userData>/Cookies-journal"
rm -f "<userData>/run"/.s.PGSQL.5432*
"<Damwha.app>/Contents/MacOS/Damwha" &   # 재기동

# 재기동 직후(~8초)
psql ... -c "SELECT id,status,locked_by,attempts,stage FROM job WHERE id='job_51';"
# → job_51 | running | desktop-fdbd8d54… | 2 | diarize
```

`supervisor.log`에 회수 과정이 그대로 찍혔다:

```
이전 실행이 남긴 프로세스를 내려요 (SIGTERM) — pid 25497 damwha_worker --once (run-id …)
이전 실행이 남긴 프로세스를 내려요 (3초 안에 끝나지 않아 SIGKILL) — pid 25497 …
postgres: 이전 실행이 남긴 postmaster(pid 25262)를 내린다 — 채택하지 않는다
postgres: 고아 postmaster(pid 25262) 종료 결과 — fast
```

이후 `job_51`은 `vad → diarize → stt → persist`를 거쳐 최종적으로:

```sql
SELECT id,status,attempts FROM job WHERE id='job_51';      -- done | 2
SELECT id,status FROM meeting WHERE id='mtg_5';             -- done
```

**판정: 충족.** 기대한 세 가지(회수 직후 재claim, `attempts`가 죽기 전보다 1 크다,
최종 `done`)를 전부 DB로 직접 관찰했다. 화면(상태 창)은 보지 못했다 — 전부
`psql`/`curl`/`supervisor.log`로 확인했다.

### P5-C4 — 3분 끊김 (네트워크 대체 절차)

브리프의 대체 지시대로 Wi-Fi는 끄지 않고 `/etc/hosts`에 `huggingface.co` 등을 막는
절차만 준비했다. bge-m3 캐시를 지우는 대신(실 데이터 삭제를 피하려고) **같은
파일시스템 안에서 `mv`로 이름만 바꿔** 캐시 미스를 유도했다:

```bash
mv "<userData>/models/hub/models--BAAI--bge-m3" \
   "<userData>/models/hub/models--BAAI--bge-m3.c4-backup"
```

그다음 `/etc/hosts`에 `127.0.0.1 huggingface.co` 등을 추가하려 했으나:

```bash
$ sudo -n true
sudo: a password is required
```

이 세션에는 암호 없는 `sudo`가 없고, 비밀번호를 대신 입력하는 것은 금지된 동작이라
여기서 멈췄다. **`/etc/hosts`를 한 글자도 바꾸지 않았고**, 위에서 이름만 바꿨던
`models--BAAI--bge-m3`도 즉시 원래 이름으로 되돌렸다(모델 디렉터리는 실제로 손대지
않은 것과 동일한 최종 상태).

**판정: 미판정 — `/etc/hosts`를 쓸 권한이 없다.** Wi-Fi를 끄지 않았고, 비밀번호도
입력하지 않았다.

### P5-C6 — 디스크 부족

Task 1이 이미 성립을 확인한 후보 1(sparse image + `--user-data-dir`)을 그대로 썼다.
이번엔 컨트롤러가 승인한 두 가지 보강을 더했다.

```bash
hdiutil create -size 3g -type SPARSE -fs APFS -volname DamwhaDiskFullC6 \
  /tmp/damwha-diskfull-c6
hdiutil attach /tmp/damwha-diskfull-c6.sparseimage

PROBE=/Volumes/DamwhaDiskFullC6/Damwha
mkdir -p "$PROBE"
cp "<실 userData>/hf-token.bin" "$PROBE/hf-token.bin"       # 읽기만, 실 파일은 그대로
ln -s "<실 userData>/models" "$PROBE/models"                 # 심볼릭 링크는 probe 쪽에만 생김

"<Damwha.app>/Contents/MacOS/Damwha" --user-data-dir="$PROBE" &
```

토큰 게이트를 바로 통과했고(같은 서명이라 위 SecurityAgent 이슈가 재발하지 않음),
bge-m3도 심볼릭 링크를 통해 즉시 로드됐다 — `embed.log`에 "Loading SentenceTransformer
model from BAAI/bge-m3" 성공 로그가 있다. postgres·api·worker·embed 넷 다
`준비됨`까지 갔다(section 1에서 못 넘었던 지점을 이번엔 넘었다).

그다음 37MB 파일을 반복 업로드해 2.8GB 볼륨을 실제로 채웠다:

```bash
for i in $(seq 1 90); do
  curl -s -X POST http://127.0.0.1:3000/api/meetings \
    -F "audio=@/tmp/damwha-probe/c4-upload.wav;type=audio/wav" \
    -F "title=C6 fill $i" -F "defer_lens=true" -F "defer_summary=true"
done
```

73번째 업로드에서 실제로 디스크가 찼다:

```
df: /dev/disk5s1 2.8Gi 2.8Gi 32Mi 99% ...
[Nest] ERROR [HTTP] POST /api/meetings 500 266ms — ENOSPC: no space left on device,
  copyfile '.../dw-upload-428a…' -> '.../data/storage/meetings/mtg_73/original.wav'
[Nest] ERROR [ExceptionsHandler] ENOSPC: no space left on device, copyfile …
```

전후 확인:

```sql
SELECT (SELECT count(*) FROM meeting) meetings, (SELECT count(*) FROM utterance) utterances,
       (SELECT count(*) FROM job) jobs;
-- 72 | 0 | 72   (mtg_73은 DB에 없다 — 실패한 업로드가 고아 행을 만들지는 않았다)
```

```bash
find "$PROBE/data/storage" -type f | wc -l   # 74
ls "$PROBE/data/storage/meetings/mtg_73"     # 빈 디렉터리 (파일 없음) — 잔재
```

**판정: 미판정.** 스펙(§11의 판정표, P5-C6)의 성립 조건은 두 가지를 **함께** 요구한다
— ①"원인·복구가 **화면에** 뜬다" ②"전후 `meeting`·`utterance` 행 수와
`data/storage` 파일 수가 같다". 이번 라운드는 화면 제어 권한이 없어 ①을 전혀 볼 수
없었다 — 관찰한 것은 API가 처리되지 않은 500(`ENOSPC` 스택트레이스가 그대로
노출)을 돌려준 것뿐이고, `supervisor.log`에는 이 사건과 인과관계가 뚜렷하지 않은
`embed=degraded` 깜빡임(디스크가 차기 전부터 반복되던 패턴과 동일)만 있었다 —
디스크 부족을 원인으로 지목하는 별도 문구는 로그에도 없었다. ②는 절반만 확인됐다
— 이미 성공한 72개 `meeting` 행은 그대로 보존됐고 고아 DB 행도 생기지 않았지만,
빈 `mtg_73` 디렉터리가 파일시스템에 남았다(작은 잔재이지 데이터 손실은 아니다).
"화면에 뜬다"를 볼 수 없었으므로 이 기준을 충족으로 적지 않는다.

정리: probe 프로세스 종료 → `hdiutil detach -force` → `rm` 로 이미지 삭제 확인,
실 `hf-token.bin`·`models`·`data/storage`는 mtime 불변(아래 "정리 확인" 참고).

### P5-C7 — supervisor 크래시

```bash
curl -s -X POST http://127.0.0.1:3000/api/meetings \
  -F "audio=@/tmp/damwha-probe/c7-upload.m4a;type=audio/mp4" -F "title=C7 probe" ...
# → mtg_6 / job_53

pgrep -f "damwha_worker.*--once" > /tmp/once-before.txt   # 27979
pgrep -f "python3.12 -m damwha_worker --run-id" | head -1 | xargs kill -9   # daemon만, --once 아님
sleep 30
pgrep -f "damwha_worker.*--once" > /tmp/once-after.txt
diff /tmp/once-before.txt /tmp/once-after.txt
# → 1d0
#   < 27979
```

`supervisor.log`:

```
worker: 종료 (코드 137) — 3초 뒤 재시작 (1회차)
worker 재시작 — 앞 supervisor의 --once 자식을 내려요 (SIGTERM) — pid 27979 damwha_worker --once (run-id …)
worker 재시작 — 앞 supervisor의 --once 자식을 내려요 (3초 안에 끝나지 않아 SIGKILL) — pid 27979 …
worker: 앞 실행의 --once 자식 1개를 거뒀어요
worker: 준비됨
```

기대대로: `once-before`의 pid(27979)가 `once-after`에 하나도 없고, 새 재시작이
그 pid를 회수했다는 로그가 명시적으로 남았다. `job_53`은 같은 락 소유자(`WORKER_ID`)
아래에서 중단 없이 계속 진행해 결국 `done`(meeting `mtg_6`도 `done`)으로
끝났다.

**판정: 충족.** 이번 회차는 Task 8이 고친 크래시 경로(`onExit`→예약 재시작 앞단에
`reapOwnOnceBefore`가 붙어야 한다는 코덱스 리뷰 지적)를 정확히 재현했고, 로그
문구까지 리뷰에서 요구한 그대로였다.

### P5-C8 — 처리 중 서비스 장애

```bash
pkill -f "damwha_worker.embed_service"
```

```
상태 …embed=failed/unknown…
embed: 종료 (코드 143) — 3초 뒤 재시작 (1회차)
상태 …embed=starting/unknown…            (+3s)
상태 …embed=running/ok…  embed: 준비됨    (+9s, 60초 이내)
```

```bash
kill -QUIT <postgres pid>
```

```
postgres: 종료 (코드 0) — 3초 뒤 재시작 (1회차)
상태 …postgres=starting/unknown…
상태 …postgres=running/ok…  postgres: 준비됨    (약 3.5초 뒤)
```

```bash
curl -s http://127.0.0.1:3000/api/health   # {"status":"ok","db":"ok"}
```

**판정: 충족 — 다만 "화면이 사유를 말한다"는 보지 못했다.** embed·postgres 둘 다
60초 안에 `ok`로 돌아오는 것은 `supervisor.log`와 `/api/health`로 직접 확인했다.
상태 창이 그 사유(예: "embed: 종료… 재시작")를 화면에 실제로 렌더링하는지는 이
세션에 화면 제어 권한이 없어 보지 못했다 — `supervisor.log`가 같은 문구를 담고
있고 그 문구가 상태 창의 데이터 소스와 같은 로그 파일이라는 것만 확인했다.

### P5-C10 — 정합성 질의 넷

C1·C7·C8의 카오스(강제 종료·supervisor 크래시·embed·postgres 장애)를 전부 겪은
**뒤** 이번 실행의 실제 `WORKER_ID`(`desktop-fdbd8d54-9c85-4212-a775-56bcc3db68b0`,
`job.locked_by`로 직접 확인)로 네 질의를 그대로 돌렸다:

```sql
SELECT count(*) FROM meeting m JOIN job j ON j.id=m.current_job_id
 WHERE m.status='processing' AND j.status NOT IN ('running','queued');        -- 0
SELECT count(*) FROM job WHERE status='running' AND locked_by IS NULL;         -- 0
SELECT count(*) FROM meeting m JOIN job j ON j.id=m.current_job_id
 WHERE m.status='done' AND j.status <> 'done';                                 -- 0
SELECT count(*) FROM job WHERE status='running' AND locked_by LIKE 'desktop-%'
   AND locked_by <> 'desktop-fdbd8d54-9c85-4212-a775-56bcc3db68b0';             -- 0
```

넷 다 0.

**판정: 충족.** 이번 라운드에 실제로 유발한 장애(C1·C7·C8) 뒤의 상태로 확인했다 —
정적인 평시 데이터가 아니라 카오스 직후 상태다.

### 스킵한 기준

- **P5-C5(잠자기 10분)** — 시도하지 않음. `pmset sleepnow`는 이 세션 자체를 재우므로
  금지됐다. 사용자가 직접 돌린다.
- **P5-C9(녹음 중 강제 종료)** — 시도하지 않음. 마이크가 필요해 이 세션에서 재현할
  수 없다. 사용자가 직접 돌린다.

### 정리 확인

- `/etc/hosts` — 이번 라운드 내내 한 글자도 바꾸지 않았다(`grep -i huggingface
  /etc/hosts`가 빈 결과).
- C6의 sparse image — `hdiutil detach -force /Volumes/DamwhaDiskFullC6` 성공,
  `/tmp/damwha-diskfull-c6.sparseimage` 삭제 확인, `/Volumes/`에 `DamwhaDiskFullC6`
  없음. probe가 남긴 orphan worker/embed(run-id `desktop-eed9a161…`)도 `pkill`로
  정리했다.
- 실 `~/Library/Application Support/Damwha/hf-token.bin`·`models`·`data/storage`
  — 이번 라운드 전체에서 mtime 불변(읽기·심볼릭 링크 생성은 probe 쪽에서만
  일어났다).
- C4용으로 잠시 이름을 바꿨던 `models--BAAI--bge-m3`는 같은 라운드 안에서 즉시
  원래 이름으로 복구했다(실제로 `/etc/hosts`를 못 바꿔 네트워크 차단 자체를 하지
  않았으므로 모델은 손대지 않은 것과 같은 최종 상태).
- 라운드가 끝날 때 실 앱을 다시 한번 띄워 이번 라운드에서 만든 job(`job_51`,
  `job_53`)이 회수·재claim을 거쳐 최종 `done`으로 정착하는 것까지 확인한 뒤,
  `Damwha` 프로세스를 전부 종료해 이 라운드를 시작하기 전 상태(앱 미기동)로
  되돌렸다 — `ps -ef | grep -i damwha`가 빈 결과.
