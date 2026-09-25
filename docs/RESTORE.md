# 업데이트 전 데이터로 되돌리기 — 수동 절차

앱 메뉴 **업데이트 전으로 되돌리기…**를 쓸 수 없을 때(창이 뜨지 않음, 마이그레이션 실패로 멈춤 등)의 절차다.
앱은 0.4.0부터 판이 바뀔 때마다 `snapshots/` 아래에 업데이트 직전 데이터를 떠 둔다.

데이터 폴더: `~/Library/Application Support/Damwha` (아래에서 `$D`)

```bash
D="$HOME/Library/Application Support/Damwha"
```

## 1. 앱과 관련 프로세스를 모두 끈다

```bash
pgrep -fl "Damwha.app/Contents|bin/postgres -D .*Damwha|damwha_worker|mlx_lm"
```

아무것도 나오지 않아야 한다. 앱이 떠 있으면 종료한다. 데이터베이스(`bin/postgres`)만 남았으면:

```bash
"/Applications/Damwha.app/Contents/Resources/postgres/bin/pg_ctl" -D "$D/data/postgres" -m fast stop
```

**`kill -9`로 데이터베이스를 끄지 않는다.**

## 2. 되돌릴 스냅샷을 고른다

```bash
for m in "$D"/snapshots/*/manifest.json; do echo "$m"; cat "$m"; echo; done
```

`fromBuild`는 업데이트 전 판, `toBuild`는 업데이트한 판, `createdAt`은 뜬 시각이다.

## 3. 지금 데이터를 옆으로 옮기고 스냅샷을 들여놓는다

```bash
SID=20260924T084933Z          # 2에서 고른 id
mv "$D/data" "$D/data.replaced-manual-$(date +%Y%m%d%H%M%S)"
cp -c -R "$D/snapshots/$SID/data" "$D/data"
printf '{"build":null,"snapshot":null,"restoredFrom":"manual-%s"}\n' "$(date +%Y%m%d%H%M%S)" > "$D/data/.damwha-generation"
```

마지막 줄은 이 데이터를 "되돌린 데이터"로 표시한다 — 그래야 나중에 새 판을 다시 열 때 앱이 옛 스냅샷을 재사용하지 않고 새로 뜬다.

`cp -c`는 복사본을 거의 공간 없이 만든다. 옮겨 둔 `data.replaced-…`는 지우지 않는 한 그대로 남는다.
`restore-journal.json`이 있으면 지운다(앱의 되돌리기가 중간에 멈췄던 흔적이다 — 이 절차가 그 일을 대신했다):

```bash
rm -f "$D/restore-journal.json"
```

`restore-staging/`도 남아 있을 수 있다(중단된 앱 내 되돌리기가 쓰던 사본). 지우지 않아도 앱 동작에는
지장이 없지만(다음 되돌리기가 새 이름을 쓴다), 공간이 아까우면 손으로 지운다:

```bash
rm -rf "$D/restore-staging"
```

## 4. 이전 판을 설치하고 연다

[릴리스 페이지](https://github.com/Yjason-K/Damwha/releases)에서 `fromBuild`의 판을 받아 설치한다.

## 최후 수단 — 스냅샷이 없고 덤프만 있을 때

`backups/*-before-*.dump`는 데이터베이스만 담는다. **녹음 파일은 담지 않는다.** 복원하면 회의 번호가
덤프 시점으로 되돌아가므로, 그 뒤에 생긴 녹음 폴더를 먼저 옮겨야 새 회의가 그 파일을 덮지 않는다.

```bash
mkdir -p "$D/storage-after-dump"
# 덤프 뒤에 생긴 회의 폴더(meetings/mtg_N)를 옮긴다 — 어느 것이 뒤에 생겼는지 모르면 전부 옮긴다.
# stderr를 죽이지 않는다 — mv가 뭐라도 말하면 거기서 멈추고 원인을 본다. 빈 폴더면 그냥 건너뛴다.
if [ -n "$(ls -A "$D/data/storage/meetings" 2>/dev/null)" ]; then
  mv "$D/data/storage/meetings/"* "$D/storage-after-dump/"
fi
B=/Applications/Damwha.app/Contents/Resources/postgres/bin
SQL="$HOME/damwha-restore-$(date +%Y%m%d%H%M%S).sql"
# 먼저 SQL 파일을 만들고 성공했는지 확인한다. 파이프로 바로 넘기면 pg_restore가 도중에 실패해도 psql이 잘린 입력을
# 커밋할 수 있다 — 그러면 스키마만 지워진 채로 남는다. 괄호 서브셸을 쓴다 — 중괄호 `{ …; exit 1; }`는 pg_restore가
# 실패하면 이 터미널 세션 자체를 닫는다.
( echo "drop schema public cascade; create schema public authorization pg_database_owner; grant usage on schema public to public;";
  "$B/pg_restore" -f - "$D/backups/<파일>.dump" || { echo "pg_restore 실패" >&2; exit 1; } ) > "$SQL" && echo "SQL 준비됨: $SQL"
# 소켓 디렉터리는 공백 없는 임시 경로를 쓴다 — pg_ctl -o는 값을 공백으로 다시 쪼개므로, "Application Support"의
# 공백이 든 $D/run을 그대로 주면 postgres가 "invalid argument"로 기동을 거부한다.
SOCK="$(mktemp -d /tmp/damwha-restore.XXXXXX)"
"$B/pg_ctl" -D "$D/data/postgres" -o "-c listen_addresses= -c unix_socket_directories=$SOCK" -w start
"$B/psql" -h "$SOCK" -U damwha damwha -X -q -1 -v ON_ERROR_STOP=1 -f "$SQL"
"$B/pg_ctl" -D "$D/data/postgres" -m fast stop
rmdir "$SOCK"
```

"SQL 준비됨"이 찍히지 않았으면 멈춘다. `psql -1 -f`는 파일 전체를 한 트랜잭션으로 돌려, 도중에 실패하면 아무것도 바뀌지 않는다. 이 방식은 데이터베이스와 짝 표시를 그대로 둔다
(`DROP DATABASE`로 지우고 다시 만들면 앱이 "다시 만든 데이터베이스"로 보고 기동을 거부한다).
