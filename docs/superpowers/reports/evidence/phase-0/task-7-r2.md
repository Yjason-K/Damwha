# 검증 증거 — Task 7 (실제 음성 처리 파이프라인) — 2회차

- 커밋: `45aacd6d5d4192d69702436f3a3de124d1f1997b` (`git -C <worktree> rev-parse HEAD`로 착수 전 확인, 지시된 `45aacd6`과 일치)
- 계보: `6668045`(본 커밋) → `1727761`(V9 스크립트, verifier r1 대상) → `8b9e2c4`·`7f849f2`(문서 커밋) → `45aacd6`(V5 수정, 이번 회차 대상)
- 환경:
  - node `v22.21.1`
  - pnpm `10.26.0`
  - 시스템 python3 (verifier 셸): `Python 3.10.21` (이 Task의 실행 대상은 아니다)
  - 번들 python (`experiments/electron-phase-0/bundle/python/bin/python3`): `Python 3.12.11`
  - Docker: `docker version` 응답함 (클라이언트 29.4.0 / 서버 29.4.0)
  - 로컬 표준시: KST (`Asia/Seoul`, UTC+9) — `date`=`2026년 9월 10일 09시 57분 33초 KST`, `date -u`=`2026년 9월 10일 00시 57분 33초 UTC`
  - 번들 PostgreSQL(55432): 착수 시점 정지 상태 확인(포트 free, `sandbox/run/pg.pid` 없음). V3(`t7-outcome.sh`)가 DB가 안 떠 있음을 감지해 `run-isolated.sh --label t7-pg-restart`로 기동(pid 87391). V11이 그 PID를 정지.
- 실행 일시: 착수 2026-09-10T00:57:06Z(HEAD 확인) ~ 종료 2026-09-10T00:58:23Z(UTC)

## V2 미실행 사유 (지시에 따름)

**이번 회차에는 V2(파이프라인 전체 실행, 약 10분)를 실행하지 않았다.**

- 수정 커밋 `45aacd6`이 건드린 파일은 `experiments/electron-phase-0/verify/t7-sandbox-models.sh`와 `experiments/electron-phase-0/verify/t7-lib.sh`뿐이다(`git show --stat 45aacd6` 확인, 아래 "착수 전 diff 확인" 참고). 파이프라인 드라이버(`drivers/process_meeting_driver.py`)·번들·`be/worker/damwha_worker`는 무변화.
- V2 결과는 이미 두 번 기록됐다:
  - 구현자 회차: `t7-pipeline.prev-20260910T003518Z.txt`, `# utc: 2026-09-09T16:08:29Z`
  - verifier r1 회차: `t7-pipeline.txt`, `# utc: 2026-09-10T00:35:18Z`
- 재실행은 약 10분이 걸리고, 증거 파일을 또 회전시켜 회차 계보를 흐린다.

| # | cwd | 명령 | 기대 | 실제 | 일치 | 종료 코드 |
| --- | --- | --- | --- | --- | --- | --- |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/lib/run-isolated.sh --label t7-pipeline -- .../process_meeting_driver.py` | exit 0. stdout에 `outcome: committed`, `t7-meeting-id.txt` 생성 | **미실행(수정 범위 밖 — r1 증거 유효)**. r1의 실측값을 그대로 옮김: `outcome: committed`, `meeting: id=mtg_2 status=done duration_ms=1883254`, `total_ms=567389`(약 9분 27초), 착수 09:25:38(KST 로그 기준) ~ 종료 09:35:18. HF 캐시 사전/사후 상태 동일(5개 저장소, 새로 받은 것 0개, 이 회차는 캐시를 이어받았다) | 미실행(수동 필요 아님 — 지시에 따른 의도적 생략) | (해당 없음) |

**착수 전 diff 확인:**

```
$ git -C <worktree> show --stat 45aacd6
 .../t7-sandbox-models.prev-20260910T005314Z.txt    |  38 +++++++
 .../t7-sandbox-models.prev-20260910T005327Z.txt    |  57 +++++++++++
 .../t7-sandbox-models.prev-20260910T005328Z.txt    |  57 +++++++++++
 .../reports/evidence/phase-0/t7-sandbox-models.txt |  29 +++++-
 .../reports/evidence/phase-0/t7-v5-idempotent.txt  |  68 +++++++++++++
 experiments/electron-phase-0/README.md             |  17 ++++
 experiments/electron-phase-0/verify/t7-lib.sh      |   9 ++
 .../electron-phase-0/verify/t7-sandbox-models.sh   | 111 ++++++++++++++++-----
 8 files changed, 358 insertions(+), 28 deletions(-)
```

코드 변경은 `verify/t7-lib.sh`(`t7_utc_of_epoch` 헬퍼 추가, `stat -f %B` → `date -u -r` 사용)와 `verify/t7-sandbox-models.sh`(판정 기준을 "현재 회차 NEW"에서 "재실행에도 성립하는 파일시스템 사실 + 회전 파일 전체를 뒤진 회차 특정"으로 변경)뿐이었다.

## 착수 전 상태

```
$ git -C <worktree> rev-parse HEAD
45aacd6d5d4192d69702436f3a3de124d1f1997b
$ git status --porcelain   # 착수 시점
(출력 없음)
$ lsof -nP -iTCP:55432 -sTCP:LISTEN   # 착수 시점
(출력 없음 — free), exit 1
$ cat experiments/electron-phase-0/sandbox/run/pg.pid
cat: ...: No such file or directory
$ ps aux | grep -iE "postgres|mlx_lm|embed_service|bundle/python|bundle/pg" | grep -v grep
(출력 없음)
$ df -g experiments/electron-phase-0   # 착수 시점
/dev/disk3s5  460  413  14  97% ...  /System/Volumes/Data   (여유 14 GiB)
```

---

## V1. `bash experiments/electron-phase-0/lib/preflight.sh 4`

- cwd: `<repo root>`
- 기대: exit 0
- 실제:
  ```
  디스크
    대상 경로 : .../experiments/electron-phase-0
    마운트    : /System/Volumes/Data
    여유      : 14 GiB
    필요      : 4 GiB
    판정      : 충분

  포트
    55432 (실험 DB): free
    58000 (mlx_lm.server): free
    58100 (embed): free

  검사 도구: otool/file/lsof/shasum/df 전부 있음
  ```
- 일치: 예 (exit 0, 여유 14 GiB ≥ 4 GiB)
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
preflight.sh — 사전 점검

디스크
  대상 경로 : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0
  마운트    : /System/Volumes/Data
  여유      : 14 GiB
  필요      : 4 GiB
  판정      : 충분

포트 (개발 기본값 5432 / 8000 / 8100과 분리된 실험 포트, 스펙 §7.1 U-6)
  55432 (실험 DB): free
  58000 (mlx_lm.server): free
  58100 (embed): free

검사 도구 (스펙 §4.0 — 피검사 대상이 아니라 측정 수단이다)
  otool: /usr/bin/otool
  file: /usr/bin/file
  lsof: /usr/sbin/lsof
  shasum: /usr/bin/shasum
  df: /bin/df

be/storage(읽기 전용 원본): /Users/gim-yeongjae/project/daewha/be/storage
```
</details>

---

## V2. 미실행 (위 "V2 미실행 사유" 절 참고)

- 일치: 미실행(수동 필요 아님 — 지시에 따른 의도적 생략)
- 종료 코드: 해당 없음

---

## V3. `bash experiments/electron-phase-0/verify/t7-outcome.sh`

- cwd: `<repo root>`
- 기대: exit 0. `t7-meeting-id.txt`의 회의가 `status='done'`
- 실제: `mtg_2`의 `status=done`, `duration_ms=1883254`, `normalized_key=meetings/mtg_2/normalized.flac`(43322865 bytes), `error=null`. `job_2` `status=done progress=100 stage=persist error=null`. 큐 0건. 파이프라인 8단계 완료 줄 전부 확인됨. **DB가 안 떠 있어 스크립트가 `run-isolated.sh --label t7-pg-restart`로 직접 기동함(pid 87391)** — r1과 다른 점.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
run-isolated: label=t7-pg-restart  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.yLKiBm/stderr.raw)
2026-09-10 09:57:19.163 KST [87391] LOG:  redirecting log output to logging collector process
2026-09-10 09:57:19.163 KST [87391] HINT:  Future log output will appear in directory "log".
== 회의 id (모든 질의를 이 id 로 스코프한다)
  t7-meeting-id.txt : mtg_2
  t6-meeting-id.txt : mtg_1
  OK   Task 6 의 회의와 다른 id 다

== 의존 서비스
  db 가 떠 있지 않다 — run-isolated.sh --label t7-pg-restart 로 기동한다
postgres 기동: pid 87391  port 55432  data .../sandbox/pgdata
준비됨 (pg_isready)
데이터베이스 damwha 있음
  db: 기동됨 (pid 87391)

== meeting 행 (mtg_2)
  status             : done
  duration_ms        : 1883254
  normalized_key     : meetings/mtg_2/normalized.flac
  processing_version : 0
  error              : null
  OK   정규화 산출물 있음: meetings/mtg_2/normalized.flac (43322865 bytes)

== job 행 (이 회의의 process_meeting)
  id       : job_2
  status   : done   progress: 100   stage: persist   attempts: 1
  error    : null

== 후속 job (payload followups 를 껐다 — 큐가 비어 있어야 한다)
  queued job: 0
  OK   재실행이 멱등하다 (다음 회차의 db.claim 이 남의 job 을 집지 않는다)

== 파이프라인 단계 완료 로그 (pipeline/timing.py::timed_stage)
   DB 행이 없는 단계(특히 VAD)는 이 줄이 유일한 직접 증거다.
  OK   normalize
       damwha_worker job=job_2 meeting=mtg_2 stage=normalize done elapsed_ms=1694 reused=0 duration_ms=1883254
  OK   vad
       damwha_worker job=job_2 meeting=mtg_2 stage=vad done elapsed_ms=7143 spans=268
  OK   diarize
       damwha_worker job=job_2 meeting=mtg_2 stage=diarize done elapsed_ms=166846 segments=1272 bounds=None-None
  OK   embed
       damwha_worker job=job_2 meeting=mtg_2 stage=embed done elapsed_ms=29242 clusters=5 raw_labels=5
  OK   identify
       damwha_worker job=job_2 meeting=mtg_2 stage=identify done elapsed_ms=11 identified=0/5 suggested=0
  OK   stt
       damwha_worker job=job_2 meeting=mtg_2 stage=stt done elapsed_ms=291035 words=4013 spans=66 clipped_ms=1844216 duration_ms=1883254
  OK   align
       damwha_worker job=job_2 meeting=mtg_2 stage=align done elapsed_ms=71240 utterances=457
  OK   persist
       damwha_worker job=job_2 meeting=mtg_2 stage=persist done elapsed_ms=129 utterances=457 clusters=5 outcome=committed

증거: .../t7-outcome.txt
판정: mtg_2 가 status='done' 이고, normalize/probe/persist 의 DB 흔적과 여덟 단계 완료 로그가 있다
```
</details>

---

## V4. `bash experiments/electron-phase-0/verify/t7-utterances.sh`

- cwd: `<repo root>`
- 기대: exit 0. `status='ok'` 발화 1건 이상, `text` 비지 않음, `diar_label` 서로 다른 값 1개 이상
- 실제: `mtg_2` 전체 457행, `status='ok'` 373행 전부 `text` 비지 않음. `diar_label` 5종(SPEAKER_00~04). ECAPA `meeting_cluster` 5행 전부 `centroid` NOT NULL, `auto_cluster` voiceprint 5건. `diar_label` 컬럼 존재(1), `speaker_cluster_id` 부재(0).
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 스코프
  대상 회의        : mtg_2  (processing_version=0)
  Task 6 의 회의   : mtg_1 — 세지 않는다
  db: 살아 있음 (pid 87391)

== utterance 의 컬럼 (화자 분리 결과는 diar_label 이다)
  diar_label         컬럼 수: 1  (1 이어야 한다)
  speaker_cluster_id 컬럼 수: 0  (0 이어야 한다 — 존재하지 않는 컬럼이다)

== 회의별 발화 수 (스코프가 갈려 있는가)
  mtg_1	12
  mtg_2	457

== mtg_2 의 발화
  전체                              : 457
  status='ok'                       : 373
  status='ok' 이고 text 가 비지 않음 : 373
  status 분포:
    ok	373
    transcribe_failed	84
  OK   text 가 있는 status='ok' 발화가 373건 (1건 이상)

== mtg_2 의 diar_label (화자 분리가 실제로 돌았는가)
  모델: pyannote/speaker-diarization-community-1
  서로 다른 diar_label: 5
  라벨별 발화 수:
    SPEAKER_00	16	6
    SPEAKER_01	156	139
    SPEAKER_02	65	51
    SPEAKER_03	93	71
    SPEAKER_04	127	106
  OK   서로 다른 diar_label 이 5개 (1개 이상)

== ECAPA 임베딩의 DB 흔적 (speechbrain/spkrec-ecapa-voxceleb, 192차원)
  meeting_cluster 행          : 5
  그중 centroid 가 NULL 이 아닌 것: 5
  auto_cluster voiceprint      : 5
  OK   centroid 5건 / voiceprint 5건 — 임베딩이 돌았다

== 텍스트 표본 (앞 3건의 길이만 — 회의 내용은 PII 라 싣지 않는다)
  order_index=0	SPEAKER_00	6
  order_index=1	SPEAKER_03	72
  order_index=2	SPEAKER_02	6

증거: .../t7-utterances.txt
판정: mtg_2 에 text 가 있는 status='ok' 발화가 1건 이상이고 diar_label 이 1개 이상이다
```
</details>

---

## V5. `bash experiments/electron-phase-0/verify/t7-sandbox-models.sh` (1회차 실행 — 채점 대상)

- cwd: `<repo root>`
- 기대: exit 0. 샌드박스 HF 캐시에 pyannote 저장소 존재 — 게이트 모델을 새로 받았다
- 실제: exit 0. 아래 "V5 전문" 절 참고
- 일치: 예
- 종료 코드: 0

### V5 전문 (착수 시각 2026-09-10T00:57:27Z 직후 실행)

```
== HF_HOME (스펙 §4.2 주입 화이트리스트)
  config.sh 의 값     : .../sandbox/home/.cache/huggingface
  t7-pipeline-env.txt : .../sandbox/home/.cache/huggingface
  OK   그 실행이 실제로 이 HF_HOME 으로 돌았다
  OK   HF_HOME 이 샌드박스 아래다

== 샌드박스 캐시의 저장소 (hub/)
  models--BAAI--bge-m3  실체파일 22개  4564396159 bytes
  models--mlx-community--Qwen3.5-4B-8bit  실체파일 12개  5163526135 bytes
  models--mlx-community--whisper-large-v3-turbo  실체파일 6개  1613980437 bytes
  models--pyannote--speaker-diarization-community-1  실체파일 6개  32821461 bytes
  models--speechbrain--spkrec-ecapa-voxceleb  실체파일 6개  88983513 bytes

== pyannote 게이트 저장소
  저장소: models--pyannote--speaker-diarization-community-1
    경로: .../sandbox/home/.cache/huggingface/hub/models--pyannote--speaker-diarization-community-1
    blobs 실체 파일: 5개  32821421 bytes  (심볼릭 링크 0개)
    OK   가중치가 샌드박스 안에 실체로 있다
    하드링크 수가 1이 아닌 blob: 0개
    OK   전부 nlink=1 — 다른 캐시에서 하드링크로 끌어온 것이 아니다
    blob 생성 시각(UTC): 2026-09-09T15:58:16Z ~ 2026-09-09T15:58:32Z
    refs/main: 3533c8cf8e369892e6b79ff1bf80f7b0286a54ee

== 어느 회차가 받았는가 (스펙 §4.4 "그 회차를 증거에 명시")
   **현재 회차의 NEW 표시로 판정하지 않는다.** 드라이버는 실행 전후의
   hub/ 차집합으로 NEW 를 찍는데, 스펙 §4.4 는 재실행 시 샌드박스
   캐시를 지우지 않고 이어받으라고 정한다. 그래서 두 번째 실행부터는
   NEW 가 반드시 0건이고, 그것으로 판정하면 검사가 영영 실패한다.
   스펙이 요구하는 것은 "빈 캐시에서 한 번만 재고 그 회차를 증거에
   명시"이므로, **회전된 회차 파일까지 전부** 뒤져 그 회차를 찾는다.
  --   t7-pipeline.txt  (utc 2026-09-10T00:35:18Z)  pyannote NEW 0건 — 캐시를 이어받은 회차
  NEW  t7-pipeline.prev-20260910T003518Z.txt  (utc 2026-09-09T16:08:29Z)
         NEW models--mlx-community--whisper-large-v3-turbo	1613980437
         NEW models--pyannote--speaker-diarization-community-1	32821461
         NEW models--speechbrain--spkrec-ecapa-voxceleb	88983513
  OK   pyannote 게이트 저장소를 새로 받은 회차가 1개 기록돼 있다: t7-pipeline.prev-20260910T003518Z.txt

== 참고 — 이 실행이 쓴 다른 모델 (게이트 아님)
  speechbrain/spkrec-ecapa-voxceleb  (화자 임베딩)
  models--mlx-community--whisper-large-v3-turbo  (STT)
  silero-vad 는 pip 패키지가 가중치를 동봉해 다운로드가 없다:
    .../bundle/python/lib/python3.12/site-packages/silero_vad/data/silero_vad.jit

증거: .../t7-sandbox-models.txt
판정: pyannote 게이트 저장소가 샌드박스 HF 캐시에 새로 받힌 실체(nlink=1)로 있고, 그 회차가 t7-pipeline.prev-20260910T003518Z.txt 에 기록돼 있다
EXIT:0
```

### 지시 항목 1 요약 — 새 출력 전문에서 뽑은 값

| 항목 | 값 |
| --- | --- |
| blobs 실체 파일 수 | 5개 |
| blobs 실체 바이트 | 32,821,421 bytes |
| 심볼릭 링크 수 | 0개 |
| **하드링크 수가 1이 아닌 blob 개수** | **0개** |
| blob 생성 시각(UTC) 범위 | 2026-09-09T15:58:16Z ~ 2026-09-09T15:58:32Z |
| `NEW models--pyannote--`를 담은 회차 파일 | `t7-pipeline.prev-20260910T003518Z.txt` |
| 그 파일의 `# utc:` | `2026-09-09T16:08:29Z` |

---

## V5 멱등 재확인 (지시 항목 2 — 연속 3회 추가 실행)

캐시를 지우지 않고 그대로 연속 3회(총 4회, 1회는 위 채점 대상 실행 포함) 실행했다.

| 회차 | 시각 | 종료 코드 |
| --- | --- | --- |
| 1회 (채점 대상, 위 V5 절) | 2026-09-10T00:57:27Z 직후 | 0 |
| 2회 | 2026-09-10T00:57:56Z 직후 | 0 |
| 3회 | 2026-09-10T00:57:57Z 직후 | 0 |
| 4회 | 2026-09-10T00:57:58Z 직후 | 0 |

2·3·4회의 stdout을 서로 `diff`한 결과 완전히 동일(`diff` exit 0, 차이 없음). 판정 문장도 동일: `판정: pyannote 게이트 저장소가 샌드박스 HF 캐시에 새로 받힌 실체(nlink=1)로 있고, 그 회차가 t7-pipeline.prev-20260910T003518Z.txt 에 기록돼 있다`.

구현자 보고(`t7-v5-idempotent.txt`)는 4회 전부 exit 0이었다고 기록했다 — 이번 회차(verifier, 4회 추가 실행 = 1(채점)+3(재확인))도 4회 전부 exit 0으로 **동일한 결과**다.

캐시는 이번 회차에서 지우지 않았다.

---

## 시간대 확인 (지시 항목 3)

```
$ date        # 로컬(KST)
2026년  9월 10일 목요일 09시 57분 33초 KST
$ date -u     # UTC
2026년  9월 10일 목요일 00시 57분 33초 UTC
$ readlink /etc/localtime
/var/db/timezone/zoneinfo/Asia/Seoul
```

blob 5개 각각에 대해 `epoch → date -u -r`(V5가 쓰는 방식)과 `epoch → date -r`(로컬), 그리고 구현자가 버린 옛 `stat -t '%Y-%m-%dT%H:%M:%SZ'` 형식을 나란히 뽑았다:

```
epoch=1788969509  utc=2026-09-09T15:58:29Z  local=2026-09-10T00:58:29 KST  old-stat-t=2026-09-10T00:58:29Z
epoch=1788969496  utc=2026-09-09T15:58:16Z  local=2026-09-10T00:58:16 KST  old-stat-t=2026-09-10T00:58:16Z
epoch=1788969512  utc=2026-09-09T15:58:32Z  local=2026-09-10T00:58:32 KST  old-stat-t=2026-09-10T00:58:32Z
epoch=1788969506  utc=2026-09-09T15:58:26Z  local=2026-09-10T00:58:26 KST  old-stat-t=2026-09-10T00:58:26Z
epoch=1788969510  utc=2026-09-09T15:58:30Z  local=2026-09-10T00:58:30 KST  old-stat-t=2026-09-10T00:58:30Z
```

대조: V5가 실제로 출력한 blob 생성 시각(`2026-09-09T15:58:16Z ~ 2026-09-09T15:58:32Z`)은 위 `date -u -r` 열의 값과 **정확히 일치**한다. 옛 `stat -t` 형식이 만드는 값(`2026-09-10T00:58:16Z` 등, 리터럴 `Z`가 붙은 로컬시각)과는 9시간(KST=UTC+9) 차이가 나며 날짜도 다르다(9/10 vs 9/9). 즉 V5가 실제로 출력하는 시각은 UTC이고 KST가 아니다.

---

## V6. `bash experiments/electron-phase-0/verify/t7-no-dev-paths.sh`

- cwd: `<repo root>`
- 기대: exit 0. dyld 증거에 개발자 경로 0건, ffmpeg가 `bundle/ffmpeg` 하위
- 실제: 금지 문자열 11종 전부 0건, 번들·`/usr/lib`·`/System/Library` 밖 로드 0건. ffmpeg/ffprobe `which` 값 `bundle/ffmpeg/bin` 하위, ffprobe 재호출(pid 76258) 메인 이미지도 동일. (`t7-pipeline-dyld.txt`는 V2를 다시 돌리지 않았으므로 r1 회차와 같은 파일 — 값 동일)
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== dyld 증거
  파일: .../t7-pipeline-dyld.txt
  dyld 줄        : 2674
  이미지 로드 줄 : 2212  (필드 3개 + <UUID> + 절대 경로)

== pid 별 메인 이미지 (규칙 6b — pid 를 먼저 고정한다)
  pid 74487  번들 아래 로드 284건
    메인 이미지: .../bundle/python/bin/python3.12
  pid 74506  번들 아래 로드 1건
    메인 이미지: .../bundle/pg/bin/postgres
  pid 74509  번들 아래 로드 2건
    메인 이미지: .../bundle/pg/bin/pg_isready
  pid 74518  번들 아래 로드 2건
    메인 이미지: .../bundle/pg/bin/pg_isready
  pid 75132  번들 아래 로드 2건
    메인 이미지: .../bundle/python/bin/python3.12
  pid 76258  번들 아래 로드 1건
    메인 이미지: .../bundle/ffmpeg/bin/ffprobe

== 금지 문자열 (이미지 로드 줄의 경로만 본다 — 규칙 6)
  OK   0건  /opt/homebrew
  OK   0건  /Library/Frameworks/Python.framework
  OK   0건  /usr/local/bin
  OK   0건  /usr/local/lib
  OK   0건  /usr/local/Cellar
  OK   0건  /usr/local/opt
  OK   0건  /Library/Developer/CommandLineTools
  OK   0건  /.venv
  OK   0건  /Users/gim-yeongjae/.cache
  OK   0건  /Users/gim-yeongjae/.local
  OK   0건  /Users/gim-yeongjae/.pyenv

== 번들·/usr/lib·/System/Library 밖에서 연 이미지 (스펙 §4.1)
  OK   0건 — 모든 pid 가 번들·/usr/lib·/System/Library 안에서만 열었다

== ffmpeg / ffprobe 실행 경로
  (a) 해석 경로 — 파이프라인과 같은 프로세스·같은 PATH 에서 잰 shutil.which()
      which ffmpeg: .../bundle/ffmpeg/bin/ffmpeg
      OK   bundle/ffmpeg 하위다
      which ffprobe: .../bundle/ffmpeg/bin/ffprobe
      OK   bundle/ffmpeg 하위다
  (b) dyld 실측 — 드라이버가 stderr 를 물려준 채로 부른 번들 ffprobe
      pid 76258 의 메인 이미지: .../bundle/ffmpeg/bin/ffprobe
      그 pid 가 bundle/ffmpeg 아래에서 연 이미지: 1건
      OK   번들 ffmpeg 바이너리가 실제로 실행됐다

== 주입 변수 기록 (스펙 §4.2 — HF_TOKEN 은 set/unset 만)
  PATH=/usr/bin:/bin:/usr/sbin:/sbin
  HOME=.../sandbox/home
  TMPDIR=.../sandbox/tmp
  DATABASE_URL=postgresql://postgres@127.0.0.1:55432/damwha
  STORAGE_ROOT=.../sandbox/storage
  MODEL_CACHE_DIR=.../sandbox/home/.cache/damwha-models
  HF_HOME=.../sandbox/home/.cache/huggingface
  EMBED_SERVICE_HOST=127.0.0.1
  EMBED_SERVICE_PORT=58100
  LENS_LLM_BASE_URL=http://127.0.0.1:58000/v1
  LENS_LLM_SERVER_BIN=.../bundle/python/bin/mlx_lm.server
  HF_TOKEN=set   # 값은 기록하지 않는다 (스펙 §4.2). 출처: be/worker/.env
  OK   HF_TOKEN 은 set 으로만 기록됐다 (값 없음)

증거: .../t7-no-dev-paths.txt
판정: dyld 이미지 로드 줄에 금지 경로가 0건이고, ffmpeg/ffprobe 가 bundle/ffmpeg 하위다
```
</details>

---

## V7. `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after`

- cwd: `<repo root>`
- 기대: exit 0. `be/storage` 원본 무변화
- 실제: **exit 1.** r1과 동일한 원인 — `before` 스냅샷(2026-09-10T00:14:47Z, 구현자가 남긴 채로 이번 회차까지 갱신되지 않음)은 `docker: daemon-unreachable`, `after`(이번 실행, 2026-09-10T00:58:13Z)는 볼륨 14개 목록을 반환했다. diff는 `docker volumes` 섹션 하나뿐이고 `be/storage` 섹션은 완전 동일.
- 일치: 아니오 (exit 코드 기준 — 원인은 docker 프로브 도달성 전환이지 `be/storage` 변경이 아니다)
- 종료 코드: 1

<details><summary>전체 출력</summary>

```
FAIL: 개발 자산이 바뀌었다
--- .../sandbox/state/dev-assets-before.txt	2026-09-10 09:14:47
+++ .../sandbox/state/dev-assets-after.txt	2026-09-10 09:58:13
@@ -1,5 +1,19 @@
 ## docker volumes
-docker: daemon-unreachable
+2deac09559ef79effc56c7230c228d0109d309fc4f208051ecc08c1c65c9ccc0
+3a0f65c5f8709d0b6b08af645aeb746d96a340603e1d37a12d4413556a16f984
+3a559c09626e43a1c2538d4173f17ecb0c710a9cabac042b7d0517f6f3a3d95e
+564b2a00aa80cb4b3795532907244d41dd6e245eae5d921bdf32a9bc9425830c
+7a6f325733f01c9cf627f80691db77ed6a4ebd06325108e804f01e6b140e5f81
+be_pgdata
+blog-local_minio_data
+blog-local_postgres_data
+c9975fd05f0848f0fe72889a84bf13ae1eb2b20bfbea00828398f19ab845473e
+damwha_pgdata
+docker_mariadb-local-data
+e33e9714513e13422fdd6cb4081a173df3460999fde456bd8294619ad0facb52
+redpanda_redpanda-data
+trb_db_db_data
+trb_db_db_logs
 ## be/storage
 root: /Users/gim-yeongjae/project/daewha/be/storage
 files: 29
```
</details>

**`be/storage` 매니페스트 확인 (지시 항목 4):**

```
$ tail -4 experiments/electron-phase-0/sandbox/state/dev-assets-after.txt
files: 29
bytes: 2227477523
newest_mtime: 1788857034
manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
```

지시된 값 `a18870e6…6391be`와 **일치**. r1의 `before`/`after`도 같은 `manifest_sha256`이었다 — 이번 회차까지 `be/storage`는 바뀌지 않았다.

---

## V8. `git status --porcelain be/worker/scripts`

- cwd: `<repo root>`
- 기대: 출력 없음
- 실제: 출력 없음
- 일치: 예
- 종료 코드: 0

---

## V9. `bash experiments/electron-phase-0/verify/t7-no-docker.sh` (지시 항목 5)

- cwd: `<repo root>`
- 기대: exit 0. `testcontainers`·`docker` 참조 0건
- 실제: exit 0. `testcontainers` 0건, `docker` 0건. 드라이버 629줄. 55432 가드 확인.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 검사 대상
  파일: .../drivers/process_meeting_driver.py
  줄 수: 629

== 리터럴 등장 (대소문자 무시, 매치된 줄 수)
  OK   0건  'testcontainers'
  OK   0건  'docker'

== 드라이버가 실제로 붙는 곳 (컨테이너가 아니라 번들 PostgreSQL 이다)
  OK   드라이버에 실험 포트 55432 가드가 있다
       40:시작 시점에 번들 PostgreSQL(55432)이 **정지 상태**라고 가정하고 이 드라이버가
       201:    if ":55432/" not in dsn:
       202:        die(f"DATABASE_URL 이 실험 포트 55432 가 아니다: {dsn!r} — 개발 DB(5432)에 쓰지 않는다")

증거: .../t7-no-docker.txt
판정: 드라이버에 'testcontainers'·'docker' 참조가 0건이다
```
</details>

---

## V10. `git status --porcelain be/src be/worker/damwha_worker fe/src packages/contracts`

- cwd: `<repo root>`
- 기대: 출력 없음
- 실제: 출력 없음
- 일치: 예
- 종료 코드: 0

---

## V11. `bash experiments/electron-phase-0/verify/t7-stop.sh` (지시 항목 5)

- cwd: `<repo root>`
- 기대: exit 0. 번들 PostgreSQL이 PID 파일 대상으로 정지, 55432 비었다
- 실제: exit 0. PID 파일의 PID `87391`(V3가 기동)이 살아 있었고 `pg_ctl -m fast stop`으로 정지. 정지 후 `kill -0 87391` 실패, 포트 55432 비었음, PID 파일 삭제됨.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 정지 대상 (PID 파일 하나가 유일한 기준이다 — 스펙 §4.4)
  PID 파일 : .../sandbox/run/pg.pid
  기록된 PID: 87391
  살아 있음 — pg/run.sh stop (pg_ctl -m fast stop)
    waiting for server to shut down.... done
    server stopped
    정지 완료 (pid 87391)

== 정지 확인
  OK   pid 87391 가 살아 있지 않다
  OK   포트 55432 가 비었다
  OK   PID 파일이 지워졌다

== 개발 인스턴스는 건드리지 않았다
  이 스크립트가 다룬 것은 위 PID 하나뿐이다. pkill/killall 은 쓰지 않는다.
  개발용 Postgres 는 5432 / damwha_pgdata 볼륨이며 이 경로 어디에도 없다.

증거: .../t7-stop.txt
판정: PID 파일의 프로세스가 내려갔고 포트 55432 가 비었다
```
</details>

---

## 검증표 요약

| # | 명령 | 기대 | 종료 코드 | 일치 |
| --- | --- | --- | --- | --- |
| V1 | `preflight.sh 4` | exit 0 | 0 | 예 |
| V2 | 파이프라인 전체 실행 | exit 0, `outcome: committed` | (해당 없음) | 미실행(수동 필요 아님 — 지시에 따른 의도적 생략, r1 값 유효) |
| V3 | `t7-outcome.sh` | exit 0, `status='done'` | 0 | 예 |
| V4 | `t7-utterances.sh` | exit 0 | 0 | 예 |
| V5 | `t7-sandbox-models.sh` | exit 0 | 0 | 예 |
| V6 | `t7-no-dev-paths.sh` | exit 0 | 0 | 예 |
| V7 | `snapshot-dev-assets.sh after` | exit 0, `be/storage` 무변화 | 1 | 아니오 (원인: docker 도달성 전환, `be/storage`는 무변화) |
| V8 | `git status --porcelain be/worker/scripts` | 출력 없음 | 0 | 예 |
| V9 | `t7-no-docker.sh` | exit 0 | 0 | 예 |
| V10 | `git status --porcelain be/src be/worker/damwha_worker fe/src packages/contracts` | 출력 없음 | 0 | 예 |
| V11 | `t7-stop.sh` | exit 0, 55432 비었음 | 0 | 예 |

## 프로세스 정리

- 기동 전(V1 직전): `ps aux | grep -iE "postgres|mlx_lm|embed_service|bundle/python|bundle/pg"` → 출력 없음. 포트 55432 free. `sandbox/run/pg.pid` 없음.
- V3 실행 중 스크립트가 직접 기동: `postgres`(pid 87391, `bundle/pg/bin/postgres -D .../sandbox/pgdata -p 55432`) + 하위 `checkpointer`/`background writer`/`walwriter`/`autovacuum launcher`/`logical replication launcher`/`logger`(87397~87403).
- V11(`t7-stop.sh`) 실행 후: `ps aux | grep -iE "postgres|bundle/pg|bundle/python"` → 출력 없음. `lsof -nP -iTCP:55432 -sTCP:LISTEN` → exit 1(비었음). `sandbox/run/pg.pid` → 파일 없음.
- 이 검증 과정에서 verifier가 직접 프로세스를 띄우거나 강제 종료한 적은 없다 — V3(`t7-outcome.sh`가 내부에서 `run-isolated.sh`로 기동)와 V11(`pg/run.sh stop` 경유)이 계획에 지정된 스크립트 안에서 처리했다. `pkill`/`killall`은 쓰지 않았다.

## 디스크 여유

- 시작(V1 직전, 2026-09-10T00:57Z): `df -g experiments/electron-phase-0` → `/dev/disk3s5 460 413 14 97% ... /System/Volumes/Data` (여유 14 GiB)
- 종료(V11 이후, 2026-09-10T00:58Z): `df -g experiments/electron-phase-0` → `/dev/disk3s5 460 413 14 97% ... /System/Volumes/Data` (여유 14 GiB, 변화 없음)

## 최종 `git status --porcelain` (전체)

```
 M docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
 M docs/superpowers/reports/evidence/phase-0/t7-no-dev-paths.txt
 M docs/superpowers/reports/evidence/phase-0/t7-no-docker.txt
 M docs/superpowers/reports/evidence/phase-0/t7-outcome.txt
 M docs/superpowers/reports/evidence/phase-0/t7-sandbox-models.txt
 M docs/superpowers/reports/evidence/phase-0/t7-stop.txt
 M docs/superpowers/reports/evidence/phase-0/t7-utterances.txt
?? docs/superpowers/reports/evidence/phase-0/t7-no-dev-paths.prev-20260910T005803Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-no-docker.prev-20260910T005819Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-outcome.prev-20260910T005719Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-pg-restart-dyld.txt
?? docs/superpowers/reports/evidence/phase-0/t7-pg-restart-env.txt
?? docs/superpowers/reports/evidence/phase-0/t7-pg-restart-stderr.txt
?? docs/superpowers/reports/evidence/phase-0/t7-sandbox-models.prev-20260910T005727Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-sandbox-models.prev-20260910T005756Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-sandbox-models.prev-20260910T005757Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-stop.prev-20260910T005823Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-utterances.prev-20260910T005723Z.txt
```

`t7-pg-restart-*.txt` 3개는 V3(`t7-outcome.sh`)가 DB를 기동하며 `run-isolated.sh --label t7-pg-restart`로 남긴 새 증거다(r1은 V2가 이미 DB를 기동해 둔 상태에서 시작해 이런 파일이 없었다). 나머지는 verify 스크립트·드라이버의 증거 회전 규칙(`.prev-<UTC타임스탬프>.txt`)에 따라 발생한 것이며, 이 세션에서 verifier가 `docs/superpowers/reports/evidence/phase-0/task-7-r2.md` 외의 파일을 직접 작성한 적은 없다. `be/src`, `be/worker/damwha_worker`, `be/worker/scripts`, `fe/src`, `packages/contracts`는 V8·V10이 확인한 대로 변경 없음. 개발 DB(5432·`damwha_pgdata`)·`be/storage`·개발자 HF 캐시에 쓰기는 관찰되지 않았다.

## 종료 시점 HEAD 재확인

```
$ git rev-parse HEAD
45aacd6d5d4192d69702436f3a3de124d1f1997b
```

착수 시점과 동일 — 검증 도중 커밋이 바뀌지 않았다.
