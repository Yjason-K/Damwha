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
