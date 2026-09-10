# 검증 증거 — Task 7 (실제 음성 처리 파이프라인)

- 커밋: `1727761a41ea10bbc4799dd14ff151075def5bb2` (`git -C <worktree> rev-parse HEAD` 로 착수 전 확인, 지시된 `1727761`과 일치)
- 환경:
  - node `v22.21.1`
  - pnpm `10.26.0`
  - 시스템 python3 (verifier 셸): `Python 3.10.21` (`/usr/bin/python3` 계열, 이 Task의 실행 대상은 아니다)
  - 번들 python (`experiments/electron-phase-0/bundle/python/bin/python3`): `Python 3.12.11`
  - Docker: 이번 세션의 `docker version` 호출은 응답함(클라이언트 29.4.0 / 서버 29.4.0, OrbStack context). Task 3~6에서 반복된 무응답과 달리 이번에는 즉시 응답했다. 단 V7 실행 시점에는 `snapshot-dev-assets.sh`가 참조하는 `before` 스냅샷이 이전 회차(00:14:47, 구현자가 남긴 것)의 `docker: daemon-unreachable` 상태를 담고 있어 diff가 그 전환을 그대로 잡았다 (아래 V7·추가 기록 7항).
  - 번들 PostgreSQL(55432): 시작 시점 정지 상태 확인(포트 free, `sandbox/run/pg.pid` 없음). V2의 드라이버가 기동, V11이 정지.
- 실행 일시: 착수 2026-09-10T00:24:12Z(HEAD 확인) ~ 종료 2026-09-10T00:36:52Z(UTC)

## 착수 전 상태

```
$ git -C <worktree> rev-parse HEAD
1727761a41ea10bbc4799dd14ff151075def5bb2
$ git status --porcelain   # 착수 시점
(출력 없음)
$ lsof -nP -iTCP:55432 -sTCP:LISTEN   # 착수 시점
(출력 없음 — free)
$ cat experiments/electron-phase-0/sandbox/run/pg.pid
cat: ...: No such file or directory
$ ps aux | grep -iE "postgres|mlx_lm|embed_service|bundle/python|bundle/pg" | grep -v grep
(출력 없음)
$ df -g experiments/electron-phase-0   # 착수 시점
/dev/disk3s5  460  412  16   97%  ...  /System/Volumes/Data   (여유 16 GiB)
```

## V1. `bash experiments/electron-phase-0/lib/preflight.sh 4`

- cwd: `<repo root>`
- 기대: exit 0. 계획이 방금 `40`→`4`로 바뀌었다 — 기존 `t7-disk-estimate.txt`(2026-09-09T15:57:58Z 작성)의 산정 내역을 아래에 그대로 옮긴다.
- 실제:
  ```
  디스크
    대상 경로 : .../experiments/electron-phase-0
    마운트    : /System/Volumes/Data
    여유      : 16 GiB
    필요      : 4 GiB
    판정      : 충분

  포트
    55432 (실험 DB): free
    58000 (mlx_lm.server): free
    58100 (embed): free

  검사 도구: otool/file/lsof/shasum/df 전부 있음
  be/storage(읽기 전용 원본): /Users/gim-yeongjae/project/daewha/be/storage
  ```
- 일치: 예 (exit 0, 여유 16 GiB ≥ 4 GiB)
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
preflight.sh — 사전 점검

디스크
  대상 경로 : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0
  마운트    : /System/Volumes/Data
  여유      : 16 GiB
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

**이전 회차 `t7-disk-estimate.txt` 산정 내역 (구현자, 2026-09-09T15:57:58Z 작성, 옮김):**

기준 호스트 데이터 볼륨 여유는 이 조사 시점 12 GiB(98% 사용)였다(스펙 §4.4가 적어 둔 "27 GiB(94%)"는 Task 2~6 이전 값). `preflight.sh 40`을 그대로 쓰면 시작조차 못 한다. 필요량 실측(HF API):

```
(A) HF 모델 다운로드 — 이 Task가 실제로 받는 것만 합산
  pyannote/speaker-diarization-community-1      33.7 MB  (게이트)
  speechbrain/spkrec-ecapa-voxceleb             89.1 MB
  mlx-community/whisper-large-v3-turbo        1,614.0 MB
  silero-vad                                       0    (pip 패키지가 가중치 동봉)
  ------------------------------------------------------
  소계                                        1,736.8 MB  ≈ 1.62 GiB

(B) 작업 산출물
  original.flac 사본                            153.9 MB
  normalized.flac (16 kHz mono, 1883 s)          ~40 MB
  DB 증가분                                       < 10 MB
  dyld/stderr 증거                                < 10 MB
  ------------------------------------------------------
  소계                                            ~214 MB  ≈ 0.20 GiB

(C) 합계 ≈ 1.82 GiB
```

판단: 12 GiB 여유 안에 들어간다(여유의 6.6배). 계획 V1의 `40`은 실제 필요량의 22배 과대 산정. 자기 점검은 `preflight.sh 4`(산정치 1.82 GiB의 2배 이상 여유)로 12 GiB에서 통과.

이번 회차(2026-09-10T00:25Z) 실측 여유는 **16 GiB**로, 위 산정과 동일하게 `4` 임계값을 충분히 만족한다.

---

## V2. `bash experiments/electron-phase-0/lib/run-isolated.sh --label t7-pipeline -- experiments/electron-phase-0/bundle/python/bin/python3 experiments/electron-phase-0/drivers/process_meeting_driver.py`

- cwd: `<repo root>`
- 기대: exit 0. stdout에 `outcome: committed`, `$EVIDENCE/t7-meeting-id.txt` 생성
- 실제: exit 0. `outcome: committed` 출력됨. `t7-meeting-id.txt` 내용 `mtg_2`. 총 소요 `total_ms=567389`(약 9분 27초, 지시된 "약 10분"과 일치). 착수 09:25:38(KST 표기 로그 기준) ~ 종료 09:35:18.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력 (stdout, run-isolated.sh 래퍼 포함)</summary>

```
2026-09-10T00:25:38Z
run-isolated: label=t7-pipeline  stderr는 실행이 끝난 뒤에 나온다
== 환경 점검 (스펙 §4.2)
  DATABASE_URL : postgresql://postgres@127.0.0.1:55432/damwha
  STORAGE_ROOT : .../sandbox/storage
  HF_HOME      : .../sandbox/home/.cache/huggingface
  HF_TOKEN     : set   # 값은 기록하지 않는다 (스펙 §4.2)
  python       : .../bundle/python/bin/python3
  오디오       : .../sandbox/audio/sample.flac (153866982 bytes)

== 번들 ffmpeg 를 PATH 앞에 붙인다
  추가한 경로  : .../bundle/ffmpeg/bin
  which ffmpeg : .../bundle/ffmpeg/bin/ffmpeg
  which ffprobe: .../bundle/ffmpeg/bin/ffprobe

== 의존 서비스
  기동: .../pg/run.sh start
postgres 기동: pid 74506  port 55432  data .../sandbox/pgdata
준비됨 (pg_isready)
데이터베이스 damwha 있음
  db: 이 드라이버가 기동

== HF 캐시 사전 상태: 5개 저장소
  - models--BAAI--bge-m3
  - models--mlx-community--Qwen3.5-4B-8bit
  - models--mlx-community--whisper-large-v3-turbo
  - models--pyannote--speaker-diarization-community-1
  - models--speechbrain--spkrec-ecapa-voxceleb

== 시드
  기존 회의 재사용: mtg_2 (재실행 멱등 — 스펙 §4.4)
  이전 회차 정리: utterance 458건, cluster 5건, provisional 화자 5건
  오디오 사본 재사용: meetings/mtg_2/original.flac (153866982 bytes)
  이전 회차의 normalized.flac 삭제 — normalize 를 이번 회차에 다시 돌린다
  job 생성: job_2 (type=process_meeting, status=queued)
  queued job 은 job_2 하나뿐이다
  meeting id 기록: .../t7-meeting-id.txt

== 모델 적재
  diarization : pyannote/speaker-diarization-community-1  (게이트)
  whisper     : large-v3-turbo  devices.stt=gpu
  embedding   : speechbrain/spkrec-ecapa-voxceleb
  transcriber : damwha_worker.models.whisper_mlx.MlxWhisper
  diarizer    : damwha_worker.models.pyannote_diar.PyannoteDiarizer
  vad         : damwha_worker.models.silero_vad.SileroVAD
  embedder    : damwha_worker.models.ecapa_embed.EcapaEmbedder

== run_once
outcome: committed

meeting: id=mtg_2 status=done duration_ms=1883254 normalized_key=meetings/mtg_2/normalized.flac
job    : id=job_2 status=done progress=100 stage=persist
utterances: 457  (status별 {'ok': 373, 'transcribe_failed': 84})
  status='ok' 이고 text 가 빈 문자열이 아닌 것: 373
diar_label 종류 5: ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_02', 'SPEAKER_03', 'SPEAKER_04']
meeting_cluster: 5행, auto_cluster voiceprint 5건

== 번들 ffprobe 재확인
  exit=0
  {
      "streams": [ { "sample_rate": "16000", "channels": 1 } ],
      "format": { "duration": "1883.254438" }
  }
  meetings/mtg_2/normalized.flac: 43322865 bytes

== HF 캐시 사후 상태: 5개 저장소 (이 실행에서 새로 받은 것 0개)
      models--BAAI--bge-m3  4564396159 bytes
      models--mlx-community--Qwen3.5-4B-8bit  5163526135 bytes
      models--mlx-community--whisper-large-v3-turbo  1613980437 bytes
      models--pyannote--speaker-diarization-community-1  32821461 bytes
      models--speechbrain--spkrec-ecapa-voxceleb  88983513 bytes

증거: .../t7-pipeline.txt
증거: .../t7-meeting-id.txt
[... stderr 로그(파이프라인 단계 로그, 아래 별도 요약) ...]
2026-09-10 09:35:18,534 INFO damwha_worker job=job_2 meeting=mtg_2 process_meeting done outcome=committed total_ms=567389
EXIT:0
2026-09-10T00:35:28Z
```

전체 stdout 원문(234줄)은 이 회차 실행 로그이며, 파이프라인 단계별 완료 줄은 `$EVIDENCE/t7-pipeline-stderr.txt`(144줄, 이번 회차 값으로 회전 저장됨, 이전 값은 `t7-pipeline-stderr.prev-20260910T003528Z.txt`)에 그대로 있다.
</details>

**주: HF_TOKEN 미인증 경고.** stderr 중 `speechbrain/spkrec-ecapa-voxceleb` 메타데이터 조회 시 `huggingface_hub.utils._http`가 "Warning: You are sending unauthenticated requests to the HF Hub"를 한 줄 남겼다(`t7-pipeline-stderr.txt`). `t7-pipeline-env.txt`에는 `HF_TOKEN=set`으로 기록돼 있고 드라이버의 `check_env()`가 토큰 부재 시 die 하므로 프로세스 환경에는 토큰이 있었다 — 이 경고는 speechbrain의 `fetching` 경로가 그 특정 HTTP 호출에 토큰을 싣지 않은 것으로 보이며, 실행 결과(outcome=committed)에는 영향이 없었다. 판정 대상이 아니므로 사실만 기록한다.

---

## V3. `bash experiments/electron-phase-0/verify/t7-outcome.sh`

- cwd: `<repo root>`
- 기대: exit 0. `t7-meeting-id.txt`의 회의가 `status='done'`
- 실제: `mtg_2`의 `status=done`, `duration_ms=1883254`, `normalized_key=meetings/mtg_2/normalized.flac`(파일 실체 43322865 bytes), `error=null`. `job_2`는 `status=done progress=100 stage=persist error=null`. 큐에 남은 job 0건. 파이프라인 8단계(normalize/vad/diarize/embed/identify/stt/align/persist) 완료 줄 전부 확인됨(아래 "추가 기록 2" 참고).
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 회의 id (모든 질의를 이 id 로 스코프한다)
  t7-meeting-id.txt : mtg_2
  t6-meeting-id.txt : mtg_1
  OK   Task 6 의 회의와 다른 id 다

== 의존 서비스
  db: 살아 있음 (pid 74506)

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
  OK   재실행이 멱등하다

== 파이프라인 단계 완료 로그 (pipeline/timing.py::timed_stage)
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
- 기대: exit 0. 그 회의의 `status='ok'` 발화 1건 이상, `text` 비어 있지 않음, `diar_label` 서로 다른 값 1개 이상
- 실제: `mtg_2` 전체 457행, `status='ok'` 373행 전부 `text` 비어 있지 않음(`transcribe_failed` 84건은 제외). `diar_label` 5종(SPEAKER_00~04). ECAPA: `meeting_cluster` 5행 전부 `centroid` NOT NULL, `auto_cluster` voiceprint 5건. `information_schema`로 `diar_label` 컬럼 존재(1), `speaker_cluster_id` 컬럼 부재(0) 확인.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 스코프
  대상 회의        : mtg_2  (processing_version=0)
  Task 6 의 회의   : mtg_1 — 세지 않는다
  db: 살아 있음 (pid 74506)

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

== 텍스트 표본 (앞 3건의 길이만)
  order_index=0	SPEAKER_00	6
  order_index=1	SPEAKER_03	72
  order_index=2	SPEAKER_02	6

증거: .../t7-utterances.txt
판정: mtg_2 에 text 가 있는 status='ok' 발화가 1건 이상이고 diar_label 이 1개 이상이다
```
</details>

**DB 결과 스코프 요약 (지시된 항목 3):**

| 항목 | 값 |
| --- | --- |
| 전체 발화 수(mtg_2) | 457 |
| `status='ok'` 수 | 373 |
| `text` 비지 않은 `ok` 수 | 373 |
| `diar_label` 종류 | 5 (SPEAKER_00~04) |
| 라벨별 발화 수(전체/ok) | SPEAKER_00: 16/6, SPEAKER_01: 156/139, SPEAKER_02: 65/51, SPEAKER_03: 93/71, SPEAKER_04: 127/106 |
| `meeting.status` | `done` |
| `job.status` / `progress` | `done` / `100` |
| 참고: Task 6 `mtg_1` | 12건 (같은 DB, 스코프 밖 — 이번 회차의 어떤 질의도 이 값을 세지 않음) |

---

## V5. `bash experiments/electron-phase-0/verify/t7-sandbox-models.sh`

- cwd: `<repo root>`
- 기대: exit 0. 샌드박스 HF 캐시에 pyannote 저장소가 존재 — 게이트 모델을 새로 받았다
- 실제: `HF_HOME`이 샌드박스 아래이고 실행 시 실제로 그 값으로 돌았음은 확인됨. `models--pyannote--speaker-diarization-community-1` blobs에 실체 파일 5개(32,821,421 bytes), 심볼릭 링크 0개, `refs/main` 존재(`3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`) — 즉 게이트 모델은 샌드박스 캐시에 실체로 있다. 다만 `t7-pipeline.txt`의 `NEW` 표시는 0건이다 — **이 회차는 모델을 새로 받지 않았다.** 지시된 대로 "모델은 이미 샌드박스 캐시에 있어 다시 받지 않는다"(V2 사전 상태에 5개 저장소가 이미 있었음, HF 캐시 사전/사후 상태 동일)와 일치하는 결과다. 스크립트는 "이 실행이 받았는가"(RC_NEW)를 조건에 넣으므로 그 조건에서 불일치가 나 exit 1이 됐다.
- 일치: 아니오 (스크립트 판정 기준 "이 실행이 새로 받았는가"에서 불일치 — 모델이 이미 캐시에 있어 새로 받지 않았다는 사실 자체는 사전 안내와 일치)
- 종료 코드: 1

<details><summary>전체 출력</summary>

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
    refs/main: 3533c8cf8e369892e6b79ff1bf80f7b0286a54ee

== 이 실행이 새로 받았는가 (드라이버가 전후로 재서 남긴 NEW 표시)
  FAIL t7-pipeline.txt 에 NEW 표시가 없다 — 전부 이미 있던 캐시였다

== 참고 — 이 실행이 쓴 다른 모델 (게이트 아님)
  speechbrain/spkrec-ecapa-voxceleb  (화자 임베딩)
  models--mlx-community--whisper-large-v3-turbo  (STT)
  silero-vad 는 pip 패키지가 가중치를 동봉해 다운로드가 없다

증거: .../t7-sandbox-models.txt
판정: 조건을 만족하지 않는다
```
</details>

**게이트 모델 신규 다운로드 여부 (지시된 항목 5):**

- 샌드박스 `models--pyannote--speaker-diarization-community-1/blobs`: **실체 파일 5개, 32,821,421 bytes, 심볼릭 링크 0개.**
- 이 실행(2026-09-10T00:25Z~00:35Z)의 HF 캐시 사전/사후 상태는 동일(5개 저장소, 새로 받은 것 0개) — `t7-pipeline.txt`의 "HF 캐시 사후 상태: 5개 저장소 (이 실행에서 새로 받은 것 0개)".
- 개발자 `~/.cache/huggingface`: `find ~/.cache/huggingface -newermt "2026-09-10T00:25:00Z"` 결과 **출력 없음** — 이번 실행 창(00:25Z~00:36Z) 동안 변경된 파일이 없다.

---

## V6. `bash experiments/electron-phase-0/verify/t7-no-dev-paths.sh`

- cwd: `<repo root>`
- 기대: exit 0. `t7-pipeline` dyld 증거에 개발자 `~/.cache`·`/opt/homebrew`·`.venv` 0건, ffmpeg 실행 경로가 `bundle/ffmpeg` 하위
- 실제: 아래 "dyld 집계" 참고. 금지 문자열 11종 전부 0건, 번들·`/usr/lib`·`/System/Library` 밖 로드 0건. ffmpeg/ffprobe `shutil.which()` 값이 `bundle/ffmpeg/bin` 하위, 별도 ffprobe 재호출(pid 76258)의 메인 이미지도 `bundle/ffmpeg/bin/ffprobe`.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== dyld 증거
  파일: .../t7-pipeline-dyld.txt
  dyld 줄        : 2674
  이미지 로드 줄 : 2212

== pid 별 메인 이미지
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

== 금지 문자열
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

== 번들·/usr/lib·/System/Library 밖에서 연 이미지
  OK   0건 — 모든 pid 가 번들·/usr/lib·/System/Library 안에서만 열었다

== ffmpeg / ffprobe 실행 경로
  (a) 해석 경로 — shutil.which()
      which ffmpeg: .../bundle/ffmpeg/bin/ffmpeg   OK bundle/ffmpeg 하위다
      which ffprobe: .../bundle/ffmpeg/bin/ffprobe OK bundle/ffmpeg 하위다
  (b) dyld 실측 — 드라이버가 stderr 를 물려준 채로 부른 번들 ffprobe
      pid 76258 의 메인 이미지: .../bundle/ffmpeg/bin/ffprobe
      그 pid 가 bundle/ffmpeg 아래에서 연 이미지: 1건
      OK   번들 ffmpeg 바이너리가 실제로 실행됐다

== 주입 변수 기록
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
  HF_TOKEN=set   # 값은 기록하지 않는다
  OK   HF_TOKEN 은 set 으로만 기록됐다

증거: .../t7-no-dev-paths.txt
판정: dyld 이미지 로드 줄에 금지 경로가 0건이고, ffmpeg/ffprobe 가 bundle/ffmpeg 하위다
```
</details>

**dyld 집계 (지시된 항목 4, `t7-pipeline-dyld.txt` 기준):**

| 항목 | 값 |
| --- | --- |
| `^dyld` 총 줄 수 | 2,674 |
| 이미지 로드 줄(필드 3개, `NF==3`) | 2,212 |
| pid 74487 메인 이미지 | `bundle/python/bin/python3.12` (드라이버, 번들 아래 로드 284건) |
| pid 74506 메인 이미지 | `bundle/pg/bin/postgres` (번들 아래 로드 1건) |
| pid 74509 메인 이미지 | `bundle/pg/bin/pg_isready` (번들 아래 로드 2건) |
| pid 74518 메인 이미지 | `bundle/pg/bin/pg_isready` (번들 아래 로드 2건) |
| pid 75132 메인 이미지 | `bundle/python/bin/python3.12` (번들 아래 로드 2건) |
| pid 76258 메인 이미지 | `bundle/ffmpeg/bin/ffprobe` (드라이버가 재호출, 번들 아래 로드 1건) |
| 금지 문자열 11종 각각 | 0건 (`/opt/homebrew`, `/Library/Frameworks/Python.framework`, `/usr/local/bin`, `/usr/local/lib`, `/usr/local/Cellar`, `/usr/local/opt`, `/Library/Developer/CommandLineTools`, `/.venv`, `$HOME/.cache`, `$HOME/.local`, `$HOME/.pyenv`) |
| 번들·`/usr/lib`·`/System/Library` 밖 로드 | 0건 (전 pid) |

**ffmpeg 자식이 dyld 증거에 없다는 사실 확인 (지시된 항목 6):**

드라이버 docstring과 `t7-no-dev-paths.sh` 주석이 명시한 대로, `be/worker/damwha_worker/pipeline/ffmpeg.py::_run`이 `capture_output=True`로 자식(ffmpeg/ffprobe)의 stderr를 파이프로 가져가기 때문에 `DYLD_PRINT_LIBRARIES=1`이 찍은 줄이 래퍼 fd 2에 도달하지 못한다 — 실제로 `t7-pipeline-dyld.txt`의 pid 목록(74487/74506/74509/74518/75132/76258)에 파이프라인이 직접 부른 ffmpeg/ffprobe 자식 pid는 없다(그 6개는 드라이버·postgres·pg_isready·드라이버가 별도로 재호출한 ffprobe뿐). 이중 확인은 다음 둘로 이뤄졌다:

1. `shutil.which()` — 파이프라인과 같은 프로세스·같은 PATH에서 잰 값. `which ffmpeg`/`which ffprobe` 모두 `.../bundle/ffmpeg/bin/` 하위.
2. 드라이버가 파이프라인 실행 뒤 별도로 stderr를 물려준 채 번들 ffprobe를 한 번 더 호출(pid 76258) — 그 dyld 실측에서 메인 이미지가 `bundle/ffmpeg/bin/ffprobe`이고 번들 아래에서 1건을 열었음을 확인.

---

## V7. `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after`

- cwd: `<repo root>`
- 기대: exit 0. `be/storage` 원본 무변화
- 실제: **exit 1.** diff는 `docker volumes` 섹션 한 곳만 잡았다 — `before`(2026-09-10T00:14:47Z, 구현자가 남긴 이전 스냅샷)는 `docker: daemon-unreachable`, `after`(이번 실행, 2026-09-10T00:36:19Z)는 볼륨 14개 목록(`damwha_pgdata`, `be_pgdata` 포함)을 반환했다. `be/storage` 섹션은 `before`/`after` 모두 `files: 29`, `bytes: 2227477523`, `newest_mtime: 1788857034`, `manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be`로 **완전히 동일** — diff에 포함되지 않았다.
- 일치: 아니오 (exit 코드 기준 — 원인은 `be/storage`가 아니라 docker 프로브 도달성 전환이라는 사실은 위 실제 값이 그대로 보여준다)
- 종료 코드: 1

<details><summary>전체 출력</summary>

```
FAIL: 개발 자산이 바뀌었다
--- .../sandbox/state/dev-assets-before.txt	2026-09-10 09:14:47
+++ .../sandbox/state/dev-assets-after.txt	2026-09-10 09:36:19
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

(`bytes`/`newest_mtime`/`manifest_sha256` 줄은 diff 컨텍스트 밖이라 `-U3`에 안 잡혔지만 `after` 파일 원문에 `bytes: 2227477523`, `newest_mtime: 1788857034`, `manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be`로 그대로 있다.)
</details>

**`be/storage` 매니페스트 확인 (지시된 항목 7):**

```
$ cat experiments/electron-phase-0/sandbox/state/dev-assets-after.txt | tail -4
root: /Users/gim-yeongjae/project/daewha/be/storage
files: 29
bytes: 2227477523
newest_mtime: 1788857034
manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
```

지시된 값 `a18870e6…6391be`와 **일치**. 이전 회차의 `before`/`after`(00:13:18Z~00:14:18Z, `t7-dev-assets.txt`에 기록)도 같은 `manifest_sha256`이었다 — 착수부터 이번 검증 종료까지 `be/storage`는 한 바이트도 바뀌지 않았다.

---

## V8. `git status --porcelain be/worker/scripts`

- cwd: `<repo root>`
- 기대: 출력 없음. smoke 스크립트를 고치지 않았다
- 실제: 출력 없음
- 일치: 예
- 종료 코드: 0

---

## V9. `bash experiments/electron-phase-0/verify/t7-no-docker.sh`

- cwd: `<repo root>`
- 기대: exit 0. 드라이버에 `testcontainers`·`docker` 참조가 없다
- 실제: exit 0. `testcontainers` 0건, `docker` 0건(대소문자 무시). 드라이버 629줄. 실험 포트 55432 가드 확인됨(3곳: docstring 40행, `check_env()` 201~202행).
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

== 드라이버가 실제로 붙는 곳
  OK   드라이버에 실험 포트 55432 가드가 있다
       40:시작 시점에 번들 PostgreSQL(55432)이 **정지 상태**라고 가정하고 이 드라이버가
       201:    if ":55432/" not in dsn:
       202:        die(f"DATABASE_URL 이 실험 포트 55432 가 아니다: {dsn!r} — 개발 DB(5432)에 쓰지 않는다")

증거: .../t7-no-docker.txt
판정: 드라이버에 'testcontainers'·'docker' 참조가 0건이다
```
</details>

**V9 자기 참조 사정 (지시된 항목 8, `t7-no-docker.prev-20260910T002222Z.txt` 요약):**

첫 실행(2026-09-10T00:22:07Z, 구현자)은 **exit 1**이었다. `testcontainers`는 0건으로 통과했지만 `docker`는 **1건** 걸렸다 — 드라이버 24번째 줄, docstring이 "왜 smoke 스크립트를 쓰지 않는가"를 설명하며 그 컨테이너 런타임 이름(리터럴 `docker`)을 한 번 적었기 때문이다. `t7-no-docker.sh` 자체가 코드와 주석·docstring을 구분하지 않고 대소문자도 무시하도록 설계돼 있어(스크립트 머리말이 명시), docstring의 설명문 표현을 "그 이름"이 아니라 뜻으로만 남기도록 고친 뒤 재실행한 것이 이번 회차이며, 결과는 위와 같이 0건/0건으로 exit 0이다. `RC_PORT`(55432 가드)는 첫 실행에서도 이미 0(OK)이었다 — 유일한 실패 원인은 `docker` 리터럴 1건이었다.

---

## V10. `git status --porcelain be/src be/worker/damwha_worker fe/src packages/contracts`

- cwd: `<repo root>`
- 기대: 출력 없음
- 실제: 출력 없음
- 일치: 예
- 종료 코드: 0

---

## V11. `bash experiments/electron-phase-0/verify/t7-stop.sh`

- cwd: `<repo root>`
- 기대: exit 0. 번들 PostgreSQL이 PID 파일 대상으로 정지하고 55432가 비었다
- 실제: exit 0. PID 파일(`sandbox/run/pg.pid`)의 기록된 PID `74506`이 살아 있었고, `pg/run.sh stop`(`pg_ctl -m fast stop`)으로 정지 완료. 정지 후 `kill -0 74506` 실패(살아 있지 않음), 포트 55432 비었음, PID 파일 삭제됨 확인.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 정지 대상
  PID 파일 : .../sandbox/run/pg.pid
  기록된 PID: 74506
  살아 있음 — pg/run.sh stop (pg_ctl -m fast stop)
    waiting for server to shut down.... done
    server stopped
    정지 완료 (pid 74506)

== 정지 확인
  OK   pid 74506 가 살아 있지 않다
  OK   포트 55432 가 비었다
  OK   PID 파일이 지워졌다

== 개발 인스턴스는 건드리지 않았다
  이 스크립트가 다룬 것은 위 PID 하나뿐이다. pkill/killall 은 쓰지 않는다.

증거: .../t7-stop.txt
판정: PID 파일의 프로세스가 내려갔고 포트 55432 가 비었다
```
</details>

---

## 추가 기록 사항 (지시된 1~8 종합)

**1. V1 종료 코드와 여유** — 위 V1 절 참고. exit 0, 여유 16 GiB, 필요 4 GiB. 이전 회차(`t7-disk-estimate.txt`) 산정 내역(모델 1.62 GiB + 오디오 사본 등 0.20 GiB = 1.82 GiB)을 위에 그대로 옮겼다.

**2. 파이프라인 단계 완료 로그** — `t7-pipeline-stderr.txt`(이번 회차 값, 144줄)에서 `stage=<이름> done` 8개 전부 확인:

| 단계 | 소요(ms) | 산출값 |
| --- | --- | --- |
| normalize | 1,694 | `reused=0 duration_ms=1883254` |
| probe | (normalize와 같은 ffprobe 호출로 `duration_ms=1883254` 확보 — 별도 `stage=probe` 줄은 없고 normalize 완료 줄에 duration_ms가 함께 찍힌다) | `duration_ms=1883254` |
| vad | 7,143 | `spans=268` |
| diarize | 166,846 | `segments=1272 bounds=None-None` |
| embed | 29,242 | `clusters=5 raw_labels=5` |
| identify | 11 | `identified=0/5 suggested=0` |
| stt | 291,035 | `words=4013 spans=66 clipped_ms=1844216 duration_ms=1883254` |
| align | 71,240 | `utterances=457` |
| persist | 129 | `utterances=457 clusters=5 outcome=committed` |

(`t7_stage_line`이 조회하는 8개 키워드는 `normalize vad diarize embed identify stt align persist`이며 전부 존재 확인됨 — V3 출력 참고. `probe`라는 별도 stage 이름의 완료 줄은 로그에 없고, duration_ms는 normalize 단계 완료 줄에 같이 실린다.)

**3. DB 결과(스코프: `t7-meeting-id.txt`=`mtg_2`)** — 위 V4 절의 표 참고. 전체 457 / `ok` 373 / `ok`이고 `text` 비지 않음 373 / `diar_label` 5종(SPEAKER_00~04, 라벨별 발화 수는 위 표) / `meeting.status=done` / `job.status=done, progress=100`. Task 6의 `mtg_1`(12건)은 별도 회의로 확인되며 어떤 질의도 그 값을 합산하지 않았다.

**4. V6 dyld 집계** — 위 V6 절의 표 참고. `^dyld` 총 2,674줄, 이미지 로드 줄 2,212줄, pid별 메인 이미지 6개 전부 `bundle/` 하위, 금지 문자열 11종 전부 0건, 번들·`/usr/lib`·`/System/Library` 밖 로드 0건.

**5. 게이트 모델 신규 다운로드 여부** — `models--pyannote--speaker-diarization-community-1`의 blobs 실체 파일 **5개, 32,821,421 bytes**, 심볼릭 링크 **0개**(전부 실체). 다만 이 회차는 "새로 받았다"에는 해당하지 않는다 — HF 캐시 사전/사후 상태가 동일(5개 저장소, `NEW` 0개)했고, 이는 지시문이 예고한 "모델은 이미 샌드박스 캐시에 있어 다시 받지 않는다"와 일치한다. 개발자 `~/.cache/huggingface`는 `find ~/.cache/huggingface -newermt "2026-09-10T00:25:00Z"` 결과 **변경 없음**(실행 창 00:25Z~00:36Z 동안).

**6. ffmpeg 자식이 dyld 증거에 없다는 사실** — 위 V6 절의 "ffmpeg 자식이 dyld 증거에 없다는 사실 확인" 참고. `pipeline/ffmpeg.py::_run`이 `capture_output=True`로 자식 stderr를 파이프로 가져가 SIP가 지운 `DYLD_*`가 래퍼에 도달하지 못하는 구조이고, 구현자가 말한 대로 이중 확인(파이프라인과 같은 프로세스의 `shutil.which()` + stderr를 물려준 별도 ffprobe 재호출의 dyld 실측)이 `t7-pipeline.txt`/`t7-pipeline-dyld.txt`에 각각 남아 있음을 확인했다.

**7. V7(`snapshot-dev-assets.sh after`)** — 이번 실행 종료 코드 **1**. diff는 `docker volumes` 섹션(`before`=daemon-unreachable → `after`=볼륨 14개 목록)뿐이고 `be/storage` 섹션은 `before`/`after` 완전 동일. `be/storage` 매니페스트는 `a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be`로 **지시된 값과 일치**했다.

**8. V9 자기 참조 사정** — 위 V9 절의 "V9 자기 참조 사정" 참고. `t7-no-docker.prev-20260910T002222Z.txt`(첫 실행, 00:22:07Z)는 exit 1이었고, 원인은 드라이버 docstring 24번째 줄이 컨테이너 런타임 이름(`docker`)을 리터럴로 한 번 적어 `RC_PATTERNS=1`이 된 것 하나뿐이다(`testcontainers` 0건, 포트 가드 `RC_PORT=0`은 그때도 이미 통과). 이번 회차는 그 리터럴이 제거된 드라이버로 실행되어 `docker`·`testcontainers` 모두 0건, exit 0이다.

## 프로세스 정리

- 기동 전(V2 실행 직전): `ps aux | grep -iE "postgres|mlx_lm|embed_service|bundle/python|bundle/pg"` → 출력 없음. 포트 55432 free. `sandbox/run/pg.pid` 없음.
- V2 실행 중 기동된 프로세스(드라이버가 직접 띄움, dyld 증거의 pid와 일치): `postgres`(pid 74506, `bundle/pg/bin/postgres -D .../sandbox/pgdata -p 55432`) + 그 하위 `checkpointer`/`background writer`/`walwriter`/`autovacuum launcher`/`logical replication launcher`/`logger`(74511~74517) + 드라이버 자신(pid 74487, `bundle/python/bin/python3`) + `pg_isready` 일시 호출(74509, 74518) + 재확인용 `ffprobe`(76258).
- V11(`t7-stop.sh`) 실행 후: `ps aux | grep -iE "postgres|bundle/pg|bundle/python"` → 출력 없음. `lsof -nP -iTCP:55432 -sTCP:LISTEN` → 출력 없음(비었음). `sandbox/run/pg.pid` → 파일 없음(`No such file or directory`).
- 이 검증 과정에서 verifier가 직접 프로세스를 띄우거나 강제 종료한 적은 없다 — V2가 기동, V11(`pg/run.sh stop` 경유)이 정지했고 둘 다 계획에 지정된 스크립트다. `pkill`/`killall`은 사용하지 않았다.

## 디스크 여유

- 시작(V1 직전, 2026-09-10T00:25Z): `df -g experiments/electron-phase-0` → `/dev/disk3s5 460 412 16 97% ... /System/Volumes/Data` (여유 16 GiB)
- 종료(V11 이후, 2026-09-10T00:36Z): `df -g experiments/electron-phase-0` → `/dev/disk3s5 460 412 13 97% ... /System/Volumes/Data` (여유 13 GiB)
- 감소분 약 3 GiB — 이번 회차가 `normalized.flac`(43,322,865 bytes ≈ 0.04 GiB)을 다시 만들었고, `t7-pipeline-dyld.txt` 등 증거 파일이 늘었으며 이전 회차의 `.prev-*.txt` 사본이 함께 남았다(회전 규칙, 스펙 §6). 데이터 볼륨 자체(16 GiB 시작)가 여러 회차에 걸쳐 다른 프로세스와 공유되는 시스템 볼륨이라 이 3 GiB 전부가 이번 실행 하나에 귀속되지는 않는다 — 사실만 남긴다.

## 최종 `git status --porcelain` (전체)

```
 M docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
 M docs/superpowers/reports/evidence/phase-0/t7-no-dev-paths.txt
 M docs/superpowers/reports/evidence/phase-0/t7-no-docker.txt
 M docs/superpowers/reports/evidence/phase-0/t7-outcome.txt
 M docs/superpowers/reports/evidence/phase-0/t7-pipeline-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t7-pipeline-env.txt
 M docs/superpowers/reports/evidence/phase-0/t7-pipeline-stderr.txt
 M docs/superpowers/reports/evidence/phase-0/t7-pipeline.txt
 M docs/superpowers/reports/evidence/phase-0/t7-sandbox-models.txt
 M docs/superpowers/reports/evidence/phase-0/t7-stop.txt
 M docs/superpowers/reports/evidence/phase-0/t7-utterances.txt
?? docs/superpowers/reports/evidence/phase-0/t7-no-dev-paths.prev-20260910T003608Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-no-docker.prev-20260910T003628Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-outcome.prev-20260910T003555Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-pipeline-dyld.prev-20260910T003528Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-pipeline-env.prev-20260910T003528Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-pipeline-stderr.prev-20260910T003528Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-pipeline.prev-20260910T003518Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-sandbox-models.prev-20260910T003601Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-stop.prev-20260910T003647Z.txt
?? docs/superpowers/reports/evidence/phase-0/t7-utterances.prev-20260910T003558Z.txt
```

이 변경분은 모두 `$EVIDENCE` 디렉터리 안에서 verify 스크립트·드라이버 자신의 증거 회전 규칙(`t7_evidence_path`/`write_evidence`, 스펙 §6 — 덮어쓰지 않고 `.prev-<UTC타임스탬프>.txt`로 옆에 둔다)에 따라 발생한 것이며, 이 세션에서 verifier가 `docs/superpowers/reports/evidence/phase-0/task-7-r1.md` 외의 파일을 직접 작성한 적은 없다. `be/src`, `be/worker/damwha_worker`, `be/worker/scripts`, `fe/src`, `packages/contracts`는 V8·V10이 확인한 대로 변경 없음.

## 종료 시점 HEAD 재확인

```
$ git rev-parse HEAD
1727761a41ea10bbc4799dd14ff151075def5bb2
```

착수 시점과 동일 — 검증 도중 커밋이 바뀌지 않았다.
