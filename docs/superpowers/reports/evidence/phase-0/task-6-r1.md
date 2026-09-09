# 검증 증거 — Task 6 (하이브리드 검색 쿼리)

- 커밋(검증 시작 시점 `git rev-parse HEAD`): `5ba13ab87410237e13edadd86c3535812d29faee`
- 지시받은 대상 COMMIT: `5ad955b`
- `git diff --stat 5ad955b..HEAD`:
  ```
   .../plans/2026-09-09-electron-phase-0-packaging-validation.md | 4 +++-
   1 file changed, 3 insertions(+), 1 deletion(-)
  ```
  → 대상 커밋 이후 변경은 `docs/superpowers/plans/...packaging-validation.md` 한 파일(계획 문서)뿐. 코드·EXP 산출물 변경 없음.
- 환경:
  - node: `v22.21.1`
  - pnpm: `10.26.0`
  - 시스템 python3(`/usr/bin/python3`): `Python 3.9.6` (검증에는 쓰지 않음 — 실제로는 `bundle/python/bin/python3` = Python 3.12를 씀)
  - docker client: `Docker version 29.4.0, build 9d7ad9f` — `docker volume ls`는 이번 세션에서도 무응답(아래 V5 참고)
  - 번들 postgres: `postgres (PostgreSQL) 16.15`
  - DB 상태(시작 시점): 포트 55432·58100 모두 `LISTEN` 없음(정지 상태), `sandbox/run/pg.pid`·`embed.pid` 없음 — 계획 지시대로 사전 기동 없이 V1부터 실행
  - 개발 DB(5432)는 OrbStack 컨테이너가 점유 중이었고 이번 세션에서 접속·조작 없음
- 실행 일시: 2026-09-09T15:18 ~ 15:24 UTC (커밋 시각과 별개로 검증 실행은 2026-09-10 KST 00:18 무렵)

## V1. `bash experiments/electron-phase-0/lib/run-isolated.sh --label t6-seed -- experiments/electron-phase-0/bundle/python/bin/python3 experiments/electron-phase-0/drivers/seed_search.py`
- cwd: `<repo root>` (`/Users/gim-yeongjae/project/daewha-electron-phase-0`)
- 기대: exit 0. 시드한 utterance 수와 embedding 수를 출력, `$EVIDENCE/t6-meeting-id.txt` 생성
- 실제:
  ```
  postgres 기동: pid 96822  port 55432  data .../sandbox/pgdata
  준비됨 (pg_isready)
  데이터베이스 damwha 있음
  기동: .../bundle/python/bin/damwha-embed  포트 127.0.0.1:58100  pid 96862
  준비됨: GET /health -> {"status":"ok"}
  == 임베딩 생성: POST http://127.0.0.1:58100/embed (12건)
    model=BAAI/bge-m3  dimension=1024  vectors=12
  == 시드: postgresql://postgres@127.0.0.1:55432/damwha
    기존 회의 재사용: mtg_1 (재실행 멱등)
    seeded utterances: 12
    seeded embeddings: 12  (model=BAAI/bge-m3 dimension=1024)
  meeting_id: mtg_1
  ```
- 일치: 예 (utterance 12건·embedding 12건 출력, `t6-meeting-id.txt` 생성 확인)
- 종료 코드: 0
<details><summary>전체 stdout(run-isolated.sh, 39줄)</summary>

```
run-isolated: label=t6-seed  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.a6IsCk/stderr.raw)
== 의존 서비스 확인 (계획 Task 6 Depends: Task 2, Task 5)
  기동: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/pg/run.sh start
postgres 기동: pid 96822  port 55432  data /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/pgdata
준비됨 (pg_isready)
데이터베이스 damwha 있음
  기동: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/services/embed.sh start
기동: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/damwha-embed
  포트     : 127.0.0.1:58100
  HF_HOME  : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface
  stderr   : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/run/embed-stderr.txt (규칙 3b의 tee 사본)
  stdout   : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/run/embed-stdout.txt
  pid      : 96862
  cmdline  : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/damwha-embed
준비됨: GET /health -> {"status":"ok"}
  db: 이 실행이 기동
  embed: 이 실행이 기동

== 임베딩 생성: POST http://127.0.0.1:58100/embed  (12건)
  model=BAAI/bge-m3  dimension=1024  vectors=12
  vectors[0][:4]=[-0.043224, 0.019021, -0.021031, 0.000468]

== 시드: postgresql://postgres@127.0.0.1:55432/damwha
  기존 회의 재사용: mtg_1 (재실행 멱등 — 스펙 §4.4)
  기존 발화 12건 삭제 (임베딩은 CASCADE)
  seeded utterances: 12
  seeded embeddings: 12  (model=BAAI/bge-m3 dimension=1024)

meeting_id: mtg_1
증거: .../t6-meeting-id.txt
증거: .../t6-seed.txt
2026-09-10 00:18:57.556 KST [96822] LOG:  redirecting log output to logging collector process
2026-09-10 00:18:57.556 KST [96822] HINT:  Future log output will appear in directory "log".
Loading weights:   0%|          | 0/391 [00:00<?, ?it/s]dyld[96915]: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> .../bundle/python/bin/python3.12
Loading weights: 100%|██████████| 391/391 [00:00<00:00, 51425.93it/s]
INFO:     Started server process [96862]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:58100 (Press CTRL+C to quit)
```
</details>

## V2. `bash experiments/electron-phase-0/verify/t6-seed.sh`
- cwd: `<repo root>`
- 기대: exit 0. `utterance_embedding`의 `model='BAAI/bge-m3'` `dimension=1024` 행 수가 시드한 utterance 수와 같고 0보다 큼
- 실제: `status='ok' 발화: 12` / `model/dimension 일치 임베딩: 12` / `processing_version 일치 발화: 12` / `t6-seed.txt 의 시드 목록: 12` — 모두 `OK`
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
== 서비스 준비
  db: 살아 있음 (pid 96822)
  embed: 살아 있음 (pid 96862)
  시드: 있음 (meeting mtg_1, 발화 12건)

== 1. 회의 (meeting_id: mtg_1)
  OK   status=done (filterSql 의 m.status='done' 조건을 만족한다)

== 2. 발화와 임베딩
  status='ok' 발화                 : 12
  model/dimension 일치 임베딩      : 12
  processing_version 일치 발화     : 12
  t6-seed.txt 의 시드 목록         : 12
  OK   발화가 0건이 아니다
  OK   임베딩 수가 발화 수와 같다 (12)
  OK   발화의 processing_version이 회의의 것(1)과 같다 — filterSql 조건
  OK   증거의 시드 목록과 DB의 발화 수가 같다

== 3. 저장된 벡터의 실제 차원 (dimension 컬럼이 아니라 vector_dims)
  OK   전 행의 vector_dims(embedding) = 1024

== 4. 벡터가 서로 다른가 (난수·상수 벡터 차단)
  OK   서로 다른 벡터가 12 개 — 같은 값을 복제해 넣은 것이 아니다
  OK   전 행의 L2 노름이 1이다 — bge-m3(정규화 출력)의 벡터 형태다

증거: .../t6-seed-check.txt
판정: 시드 12건과 같은 수의 bge-m3 1024차원 임베딩이 실험 DB에 있다
```
</details>

## V3. `bash experiments/electron-phase-0/verify/t6-hybrid.sh`
- cwd: `<repo root>`
- 기대: exit 0. `kw` 단독 1건 이상 **그리고** `sem` 단독 1건 이상 **그리고** `fused` 1건 이상
- 실제: 질의 `'예산'`, cand_k=100 rrf_k=60에서 **kw=3 / sem=12 / fused=12**. 세 조건 모두 `OK`.
  - cand_k=3 재실행: **kw=3 / sem=3 / fused=4** (kw에만 1건 `utt_38`, sem에만 1건 `utt_40`, 둘 다 2건) — `fused 집합 = kw ∪ sem (4)` `OK`
  - sem 상위 3건: `utt_37`(group=kw), `utt_39`(group=kw), `utt_40`(group=sem, "예산" 글자 없음) — `상위 3건에 '예산' 글자가 없는 발화가 1건 있다` `OK`
- 일치: 예 (구현자 보고의 kw 3 / sem 12 / fused 12, cand_k=3 재실행 kw 3 / sem 3 / fused 4는 정확히 일치. 다만 sem 상위 3건에 든 "예산 없는" 발화 id는 구현자 보고의 `utt_28`이 아니라 `utt_40`이었다 — 이번 실행에서 회의 발화를 삭제 후 재시드해 utterance id가 `utt_37`~`utt_48`로 새로 채번됐기 때문. 텍스트 내용은 동일: "재무팀이 비용 절감안을 검토하고 있습니다.")
- 종료 코드: 0
<details><summary>전체 출력(t6-hybrid.txt, 77줄 — 쿼리 결과 원본 포함)</summary>

```
# Task 6 V3 — 하이브리드 검색 (스펙 P0-C2)
# utc: 2026-09-09T15:19:30Z
# meeting_id: mtg_1
# 질의: '예산'   질의 벡터: embed 서비스 http://127.0.0.1:58100/embed 산출
# 파라미터: cand_k=100 rrf_k=60 dim=1024 model=BAAI/bge-m3 limit+1=21 ef_search=100
#
# arm 별 건수: kw=3  sem=12  fused=12
# ('예산' 을 담은 시드 발화: 3 건)

## 판정
# C·D — sem 상위 3건이 의미를 담는가 (group 은 t6-seed.txt 의 열)
  1위 utt_37  이번 분기 예산 집행 현황을 먼저 보고드리겠습니다.
  2위 utt_39  예산 승인은 다음 주 화요일 임원 회의에서 결정됩니다.
  3위 utt_40  재무팀이 비용 절감안을 검토하고 있습니다.
     utt_37 -> group=kw
     utt_39 -> group=kw
     utt_40 -> group=sem
  OK   상위 3건에 주제가 다른(off) 발화가 없다
  OK   상위 3건에 '예산' 글자가 없는 발화가 1건 있다
       — LIKE likequery() 로는 절대 찾을 수 없는 행을 <=> 가 찾았다
# E — kw 결과가 전부 '예산' 을 담는가: 어긋난 행 0 건 / 담은 시드 3 건
# B·G — FULL OUTER JOIN 과 RRF (cand_k=100)
  OK   fused 집합 = kw ∪ sem (12 = 3 ∪ 12)
  OK   fused 점수 12건이 전부 COALESCE(1/(60+kw.rnk),0)+COALESCE(1/(60+sem.rnk),0) 와 같다
  참고 두 arm 모두: 3건 / kw 에만: 0건 / sem 에만: 9건
# F — cand_k=3 재실행
  kw=3 sem=3 fused=4  (kw에만 1 / sem에만 1 / 둘 다 2)
  OK   kw 에만 있는 행이 있다: ['utt_38']
  OK   sem 에만 있는 행이 있다: ['utt_40']
  OK   fused 집합 = kw ∪ sem (4)

## 쿼리 결과 (cand_k=100)
# arm  rnk  score  utterance_id  meeting_id  text
fused	1	0.03278688524590164	utt_37	mtg_1	이번 분기 예산 집행 현황을 먼저 보고드리겠습니다.
fused	2	0.03225806451612903	utt_39	mtg_1	예산 승인은 다음 주 화요일 임원 회의에서 결정됩니다.
fused	3	0.03149801587301587	utt_38	mtg_1	마케팅 예산은 작년 대비 이십 퍼센트 줄었습니다.
fused	4	0.015873015873015872	utt_40	mtg_1	재무팀이 비용 절감안을 검토하고 있습니다.
fused	5	0.015384615384615385	utt_41	mtg_1	지출 항목을 다시 정리해서 회계 부서에 넘기겠습니다.
fused	6	0.015151515151515152	utt_42	mtg_1	자금 집행 승인 절차가 늦어져 대금 결제가 밀렸습니다.
fused	7	0.014925373134328358	utt_44	mtg_1	주말에 비가 온다고 해서 등산 일정을 미뤘습니다.
fused	8	0.014705882352941176	utt_47	mtg_1	회의실 프로젝터 케이블이 자꾸 빠집니다.
fused	9	0.014492753623188406	utt_46	mtg_1	다음 스프린트 회고는 금요일 오후에 진행합니다.
fused	10	0.014285714285714285	utt_48	mtg_1	출장 숙소는 역 근처로 예약했습니다.
fused	11	0.014084507042253521	utt_45	mtg_1	새로 산 노트북 배터리가 하루를 못 버팁니다.
fused	12	0.013888888888888888	utt_43	mtg_1	점심은 회사 앞 국밥집에서 먹기로 했습니다.
kw	1		utt_37	mtg_1	이번 분기 예산 집행 현황을 먼저 보고드리겠습니다.
kw	2		utt_39	mtg_1	예산 승인은 다음 주 화요일 임원 회의에서 결정됩니다.
kw	3		utt_38	mtg_1	마케팅 예산은 작년 대비 이십 퍼센트 줄었습니다.
sem	1		utt_37	mtg_1	이번 분기 예산 집행 현황을 먼저 보고드리겠습니다.
sem	2		utt_39	mtg_1	예산 승인은 다음 주 화요일 임원 회의에서 결정됩니다.
sem	3		utt_40	mtg_1	재무팀이 비용 절감안을 검토하고 있습니다.
sem	4		utt_38	mtg_1	마케팅 예산은 작년 대비 이십 퍼센트 줄었습니다.
sem	5		utt_41	mtg_1	지출 항목을 다시 정리해서 회계 부서에 넘기겠습니다.
sem	6		utt_42	mtg_1	자금 집행 승인 절차가 늦어져 대금 결제가 밀렸습니다.
sem	7		utt_44	mtg_1	주말에 비가 온다고 해서 등산 일정을 미뤘습니다.
sem	8		utt_47	mtg_1	회의실 프로젝터 케이블이 자꾸 빠집니다.
sem	9		utt_46	mtg_1	다음 스프린트 회고는 금요일 오후에 진행합니다.
sem	10		utt_48	mtg_1	출장 숙소는 역 근처로 예약했습니다.
sem	11		utt_45	mtg_1	새로 산 노트북 배터리가 하루를 못 버팁니다.
sem	12		utt_43	mtg_1	점심은 회사 앞 국밥집에서 먹기로 했습니다.

## 쿼리 결과 (cand_k=3 — FULL OUTER JOIN 양방향 확인용)
fused	1	0.03278688524590164	utt_37	mtg_1	이번 분기 예산 집행 현황을 먼저 보고드리겠습니다.
fused	2	0.03225806451612903	utt_39	mtg_1	예산 승인은 다음 주 화요일 임원 회의에서 결정됩니다.
fused	3	0.015873015873015872	utt_38	mtg_1	마케팅 예산은 작년 대비 이십 퍼센트 줄었습니다.
fused	4	0.015873015873015872	utt_40	mtg_1	재무팀이 비용 절감안을 검토하고 있습니다.
kw	1		utt_37	mtg_1	이번 분기 예산 집행 현황을 먼저 보고드리겠습니다.
kw	2		utt_39	mtg_1	예산 승인은 다음 주 화요일 임원 회의에서 결정됩니다.
kw	3		utt_38	mtg_1	마케팅 예산은 작년 대비 이십 퍼센트 줄었습니다.
sem	1		utt_37	mtg_1	이번 분기 예산 집행 현황을 먼저 보고드리겠습니다.
sem	2		utt_39	mtg_1	예산 승인은 다음 주 화요일 임원 회의에서 결정됩니다.
sem	3		utt_40	mtg_1	재무팀이 비용 절감안을 검토하고 있습니다.
```
</details>

## V4. `bash experiments/electron-phase-0/verify/t6-operators.sh`
- cwd: `<repo root>`
- 기대: exit 0. `bigm_similarity`와 `likequery`가 동작하고 `<=>` 거리 연산이 동작
- 실제:
  - `likequery('예산') = %예산%`, `likequery('50% 절감') = %50\% 절감%` (특수문자 `%` 이스케이프 확인)
  - `bigm_similarity`: 동일 문자열 `1.000000`, 유사 문자열(`예산 집행`/`예산 승인`) `0.500000`, 무관 문자열(`예산 집행`/`국밥 점심`) `0.000000`
  - `<=>`: 직교(`[1,0,0]`↔`[0,1,0]`) `1.000000`, 동일(`[1,2,3]`↔`[1,2,3]`) `0.000000`, 반대(`[1,0,0]`↔`[-1,0,0]`) `2.000000`
  - 함수 소속(`pg_depend`): `likequery`·`bigm_similarity` → `pg_bigm`, `cosine_distance`(`<=>`의 oprcode) → `vector`
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력(t6-operators.txt, 50줄)</summary>

```
# Task 6 V4 — pg_bigm / pgvector 연산 확인 (스펙 P0-C2)
# utc: 2026-09-09T15:19:37Z
# 번들 pkglibdir: .../experiments/electron-phase-0/bundle/pg/lib/postgresql
# meeting_id: mtg_1   질의: '예산'

## likequery
likequery('예산')      = %예산%
likequery('50% 절감')       = %50\% 절감%
LIKE likequery 로 고른 행   = 3
position() 으로 고른 행     = 3

## bigm_similarity
('예산 집행','예산 집행')   = 1.000000
('예산 집행','예산 승인')   = 0.500000
('예산 집행','국밥 점심')   = 0.000000
[0,1] 밖의 값               = 0 건
서로 다른 값                = 7 가지

## <=>
'[1,0,0]' <=> '[0,1,0]'     = 1.000000
'[1,2,3]' <=> '[1,2,3]'     = 0.000000
'[1,0,0]' <=> '[-1,0,0]'    = 2.000000
자기 거리 != 0 인 행         = 0
서로 다른 거리 값            = 12 가지 / 12 행

## 시드 임베딩과 질의 '예산' 의 거리 (가까운 순)
# order_index  utterance_id  dist  bigm_similarity  LIKE likequery  text
0	utt_37	0.415915	0.103448	t	이번 분기 예산 집행 현황을 먼저 보고드리겠습니다.
2	utt_39	0.422924	0.096774	t	예산 승인은 다음 주 화요일 임원 회의에서 결정됩니다.
3	utt_40	0.447308	0.000000	f	재무팀이 비용 절감안을 검토하고 있습니다.
1	utt_38	0.503478	0.071429	t	마케팅 예산은 작년 대비 이십 퍼센트 줄었습니다.
4	utt_41	0.510747	0.000000	f	지출 항목을 다시 정리해서 회계 부서에 넘기겠습니다.
5	utt_42	0.570905	0.000000	f	자금 집행 승인 절차가 늦어져 대금 결제가 밀렸습니다.
7	utt_44	0.580595	0.035714	f	주말에 비가 온다고 해서 등산 일정을 미뤘습니다.
10	utt_47	0.598412	0.000000	f	회의실 프로젝터 케이블이 자꾸 빠집니다.
9	utt_46	0.611807	0.000000	f	다음 스프린트 회고는 금요일 오후에 진행합니다.
11	utt_48	0.616974	0.047619	f	출장 숙소는 역 근처로 예약했습니다.
8	utt_45	0.662165	0.038462	f	새로 산 노트북 배터리가 하루를 못 버팁니다.
6	utt_43	0.669956	0.000000	f	점심은 회사 앞 국밥집에서 먹기로 했습니다.

## 함수 소속 (pg_depend)
bigm_similarity	pg_bigm	$libdir/pg_bigm
cosine_distance	vector	$libdir/vector
cosine_distance	vector	$libdir/vector
cosine_distance	vector	$libdir/vector
likequery	pg_bigm	$libdir/pg_bigm
vector <=> vector 의 oprcode = public.cosine_distance
```
</details>

## V5. `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after`
- cwd: `<repo root>`
- 기대: exit 0. `be/storage` 원본 무변화
- **시도 1** (지시된 명령을 별도 방어막 없이 그대로 실행, 다만 안전을 위해 외부 `timeout 90`으로 감쌌다): `docker volume ls`가 무응답으로 걸려 90초 뒤 `timeout`이 wrapper bash 전체를 죽였다. 종료 코드 124, `dev-assets-after.txt`에는 `## docker volumes` 헤더만 남고 그 뒤가 비어 있었다(불완전 산출물). 이후 `ps aux`로 확인했으나 그 시점엔 이미 프로세스가 정리돼 있어 개별 PID를 특정하지 못했다.
- 재확인: `docker volume ls`를 단독으로 실행해 20초간 관찰한 결과 실제로 무응답임을 확인 — pid `98097`, `ps -p 98097` → `docker volume ls --format {{.Name}}`. 지시에 따라 `pkill`/`killall` 없이 `kill -TERM 98097`(→ 확인 후 필요시 `-KILL`, 이번엔 TERM만으로 종료)로 그 PID만 종료했다.
- **시도 2** (재실행, 스크립트 실행 중 동일하게 걸린 `docker volume ls` 클라이언트 PID `98216`만 `kill -TERM`으로 종료): 스크립트가 `docker: daemon-unreachable`로 처리하고 계속 진행해 정상 종료.
- 실제(시도 2 출력):
  ```
  개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다
  ## docker volumes
  docker: daemon-unreachable
  ## be/storage
  root: /Users/gim-yeongjae/project/daewha/be/storage
  files: 29
  bytes: 2227477523
  newest_mtime: 1788857034
  manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
  ```
  `before` 스냅샷(`sandbox/state/dev-assets-before.txt`, 2026-09-09 23:52:13 KST 작성, 이번 세션 이전)도 `docker: daemon-unreachable` / `files: 29` / `bytes: 2227477523` / 동일 `manifest_sha256`로, `after`와 완전히 일치.
- 일치: 예 (be/storage 무변화 부분). docker volume ls는 두 스냅샷 모두 "daemon-unreachable"로 같게 처리되어 스크립트 자체의 비교 조건은 만족했으나, 이것이 "볼륨이 실제로 그대로다"를 증명하는 것은 아니고 "매 호출 무응답을 같은 방식으로 처리했다"는 뜻이다 — 무응답의 근본 원인은 조사하지 않았다(계획 지시: "그 CLI 클라이언트 PID만 종료하고 기록"에 따름).
- **재시도 성격 기록**: 시도 1은 검증 자체가 실패한 것이 아니라 내가 두른 외부 `timeout 90`이 스크립트를 강제 종료해 불완전 산출물을 냈다. 시도 2는 계획이 지시한 대로("매달리면 그 CLI 클라이언트 PID만 종료") 동작해 스크립트가 스스로 완결됐다. 두 시도 모두 위에 남긴다.
- 종료 코드: 시도 1 = 124(외부 timeout에 의함, 스크립트 자체 종료 코드 아님) / 시도 2 = 0
<details><summary>시도 1 전체 출력(불완전, 그대로 보존)</summary>

```
(빈 출력 — 외부 timeout이 90초 뒤 프로세스 트리를 종료해 stdout에 아무것도 기록되지 않았다)
```
</details>
<details><summary>시도 2 전체 출력</summary>

```
개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다
## docker volumes
docker: daemon-unreachable
## be/storage
root: /Users/gim-yeongjae/project/daewha/be/storage
files: 29
bytes: 2227477523
newest_mtime: 1788857034
manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
```
</details>

---

## 지시받은 확인 항목 1~7

### 1. kw·sem·fused 결과 건수
- 질의 `'예산'`, cand_k=100, rrf_k=60에서: **kw = 3 / sem = 12 / fused = 12**.
- kw·sem 모두 각각 0건이 아니다 — kw 3건, sem 12건 모두 1건 이상.
- 구현자 보고(kw 3 / sem 12 / fused 12)와 수치가 정확히 일치.

### 2. fused가 FULL OUTER JOIN인지 (cand_k=3 재실행)
- 재실행이 t6-hybrid.sh 안에 있고(위 V3 "F — cand_k=3 재실행" 절), 이번 실행 결과: **kw=3 / sem=3 / fused=4**, kw에만 1건(`utt_38`), sem에만 1건(`utt_40`), 둘 다 2건(`utt_37`, `utt_39`).
- 구현자 보고(kw 3 / sem 3 / fused 4, kw에만 1 / sem에만 1 / 둘 다 2)와 건수 구조가 정확히 일치. utterance id 문자열만 다르다(이번 실행은 `utt_37`~`utt_48`, 재시드로 새로 채번됨).

### 3. sem이 의미 있는 거리를 내는가
- sem 상위 3건: `utt_37`("이번 분기 예산 집행 현황을...", group=kw), `utt_39`("예산 승인은...", group=kw), `utt_40`("재무팀이 비용 절감안을 검토하고 있습니다.", group=sem — **"예산" 글자 없음**).
- t6-operators.txt의 거리표(가까운 순): `utt_37` dist=0.415915, `utt_39` dist=0.422924, `utt_40` dist=0.447308(3위, "예산" 없음에도 bigm_similarity=0.000000·LIKE=f), 이하 `utt_38`(0.503478) 등. 4위 이후로 갈수록 거리가 멀어지고 마지막(`utt_43`, off 그룹, "점심은 회사 앞 국밥집에서...")이 dist=0.669956로 가장 멀다.
- 구현자 보고의 "sem 상위 3건에 예산 글자 없는 항목 포함"(그쪽은 `utt_28`)과 같은 현상이 이번 실행(`utt_40`)에서도 재현됨 — 난수 벡터가 아니라 실제 의미 임베딩이라는 근거로 일치.

### 4. 연산자 실측
- `likequery('예산')` = `%예산%`
- `likequery('50% 절감')` = `%50\% 절감%` (LIKE 특수문자 `%` 이스케이프됨)
- `bigm_similarity`: 동일(`예산 집행`/`예산 집행`) = `1.000000`, 유사(`예산 집행`/`예산 승인`) = `0.500000`, 무관(`예산 집행`/`국밥 점심`) = `0.000000`
- `<=>`: 직교(`[1,0,0]`↔`[0,1,0]`) = `1.000000`, 동일(`[1,2,3]`↔`[1,2,3]`) = `0.000000`, 반대(`[1,0,0]`↔`[-1,0,0]`) = `2.000000`

### 5. 시드 내역
- meeting id: `mtg_1`, title "Phase 0 Task 6 하이브리드 검색 시드", status=done, processing_version=1
- 발화 수: 12 (status='ok' 전부)
- 임베딩 수: 12
- `model` = `BAAI/bge-m3`, `dimension` = `1024` (전 12행, `vector_dims != 1024`인 행 0건)
- 벡터 12개가 서로 다른지: `서로 다른 벡터: 12` (전부 서로 다름, 중복 없음)
- L2 노름: `L2 노름 = 1 인 행: 12` (전 행 L2=1, bge-m3 정규화 출력과 일치)

### 6. t6-seed-dyld.txt의 pid 분포
- `^dyld` 줄 총합: **2577줄**
- pid별 줄 수:
  | pid | 줄 수 | 정체(첫 줄의 메인 이미지 및 `ps` 대조로 확인) |
  | --- | --- | --- |
  | 96862 | 915 | embed 서비스(uvicorn, `damwha-embed`) 자신 — V1 stdout의 `pid: 96862`와 일치 |
  | 96803 | 715 | `seed_search.py` 드라이버 자신(run-isolated.sh의 argv 프로세스, `bundle/python/bin/python3.12`가 메인 이미지) |
  | 96915 | 702 | embed 서비스가 띄운 `multiprocessing.resource_tracker` 자식(`ps`로 `python3.12 -c "from multiprocessing.resource_tracker import main;main(8)"` 확인). t6-seed-stderr.txt 4번째 줄(아래 7번)의 dyld 줄도 이 pid 소속이나 `^dyld`로 시작하지 않아 이 2577줄 집계에서 빠져 있다(즉 96915의 실제 로드 줄 수는 702+1 = 703) |
  | 96835 | 82 | `bundle/pg/bin/pg_isready` (준비 대기 폴링 1회차) |
  | 96825 | 82 | `bundle/pg/bin/pg_isready` (준비 대기 폴링 2회차) |
  | 96822 | 81 | `bundle/pg/bin/postgres` 서버 자신 — V1 stdout의 `postgres 기동: pid 96822`와 일치 |
- pid가 6개로 섞이는 것은 지시받은 대로 서버(postgres·embed)와 그 보조 프로세스(pg_isready 폴링, embed의 resource_tracker), 그리고 `seed_search.py` 드라이버 자신이 모두 같은 `--label t6-seed` 실행 안에서 dyld를 찍었기 때문이다.

### 7. t6-seed-stderr.txt의 dyld 줄 혼입
- 파일의 4번째 줄:
  ```
  Loading weights:   0%|          | 0/391 [00:00<?, ?it/s]dyld[96915]: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12
  ```
- 이 줄은 `tqdm` 진행 표시줄(`Loading weights: ...`)로 시작해 `^dyld` 정규식에 걸리지 않는다. 안에 담긴 dyld 줄은 pid `96915`(위 6번의 `resource_tracker` 자식)가 자신의 메인 이미지 `python3.12`를 로드한 기록이며, 경로는 `experiments/electron-phase-0/bundle/python/bin/python3.12` — **번들(`bundle/python`) 안**이다.
- 이 UUID(`4C4C44A6-...`)는 t6-seed-dyld.txt에 잡힌 96915의 첫 `^dyld` 줄 UUID(`4C4C440E-...`, `libpython3.12.dylib`)와 다르다 — 즉 이 혼입 줄은 96915가 dyld에 찍은 **첫 번째** 로드 기록(메인 이미지 자신)이고, `^dyld` 필터를 쓰면 이 한 줄만 빠지고 이후 줄들은 정상 포착된다.

---

## 프로세스 정리
- 기동 전(V1 실행 전): `postgres|embed_service|uvicorn|mlx_lm` 관련 프로세스 없음, 포트 55432·58100 `LISTEN` 없음.
- V1~V5 진행 중 기동됨: postgres(pid 96822, `-D sandbox/pgdata -p 55432`), embed(pid 96862, `damwha-embed`), embed의 `resource_tracker` 자식(pid 96915).
- 정리 명령: `experiments/electron-phase-0/pg/run.sh stop` → `waiting for server to shut down.... done / server stopped / 정지 완료 (pid 96822)`. `experiments/electron-phase-0/services/embed.sh stop` → `SIGTERM: pid 96862 / 종료 확인 (SIGTERM 1s 안에 내려갔다)`.
- 종료 후: `ps aux | grep -Ei 'bundle/pg/bin/postgres|bundle/python/bin/python3.12|damwha-embed|resource_tracker'` → 매치 없음. `lsof -iTCP:55432 -sTCP:LISTEN`·`lsof -iTCP:58100 -sTCP:LISTEN` → 모두 빈 출력. `sandbox/run/pg.pid`·`sandbox/run/embed.pid` → 둘 다 없음(파일 삭제됨).
- `pkill`/`killall`은 쓰지 않았다. V5 중 무응답 `docker volume ls` 클라이언트 2건(pid `98097`, `98216`)만 `kill -TERM`으로 개별 종료했다 — 이는 검증 대상 서버 프로세스가 아니라 내가 직접 실행해 관찰한 진단용 `docker` CLI 호출이다.

## 종료 시점 상태
- 포트 55432: 미점유 (`lsof` 빈 출력)
- 포트 58100: 미점유 (`lsof` 빈 출력)
- PID 파일: `sandbox/run/pg.pid` 없음, `sandbox/run/embed.pid` 없음

## `docs/superpowers/reports/evidence/phase-0/` 파일 수와 확장자별 개수 (이 증거 파일 작성 직전 기준)
- 전체: 145개 (`.md` 8개, `.txt` 137개)
- 참고: 이 개수는 V1~V5 실행이 끝난 뒤, 이 `task-6-r1.md`를 쓰기 **전** 시점의 스냅샷이다. `t6-*.txt` 다수는 Verify 스크립트 자신이 계획에 규정된 회전 규칙(`*.prev-<timestamp>.txt`)에 따라 이번 실행으로 새로 쓰거나 이전 회차를 아카이브한 것이며, 내가 직접 편집·삭제하지 않았다.

## `git status --porcelain` 전체 (V1~V5 실행 후)
```
 M docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
 M docs/superpowers/reports/evidence/phase-0/t6-hybrid.txt
 M docs/superpowers/reports/evidence/phase-0/t6-operators.txt
 M docs/superpowers/reports/evidence/phase-0/t6-seed-check.txt
 M docs/superpowers/reports/evidence/phase-0/t6-seed-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t6-seed-env.txt
 M docs/superpowers/reports/evidence/phase-0/t6-seed-stderr.txt
 M docs/superpowers/reports/evidence/phase-0/t6-seed.txt
?? docs/superpowers/reports/evidence/phase-0/t6-hybrid.prev-20260909T151930Z.txt
?? docs/superpowers/reports/evidence/phase-0/t6-operators.prev-20260909T151937Z.txt
?? docs/superpowers/reports/evidence/phase-0/t6-seed-check.prev-20260909T151926Z.txt
?? docs/superpowers/reports/evidence/phase-0/t6-seed-dyld.prev-20260909T151912Z.txt
?? docs/superpowers/reports/evidence/phase-0/t6-seed-env.prev-20260909T151912Z.txt
?? docs/superpowers/reports/evidence/phase-0/t6-seed-stderr.prev-20260909T151912Z.txt
?? docs/superpowers/reports/evidence/phase-0/t6-seed.prev-20260909T151912Z.txt
```
- 변경분은 전부 `docs/superpowers/reports/evidence/phase-0/` 아래 `.txt`(V1~V5가 계획에 규정된 회전 규칙으로 스스로 쓴 것)뿐이다. 이 `task-6-r1.md` 파일 자체는 `git status` 실행 시점엔 아직 존재하지 않았다(방금 작성).
- `be/src`·`be/worker/damwha_worker`·`be/worker/scripts`·`fe/src`·`packages/contracts`에는 변경 없음 (`git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts` — 별도 실행하지 않았으나 위 전체 `--porcelain` 출력에 해당 경로가 전혀 나타나지 않아 무변화임을 확인).
