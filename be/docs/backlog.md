# Damwha 백엔드 — 백로그 (알려진 후속 이슈)

> 살아있는 문서. 출하 후 발견된 개선/수정 후보를 잊지 않도록 기록한다. 날짜 스냅샷이 아니므로 계속 개정한다.
> 스펙/플랜은 사후 편집하지 않으므로(규약), 이미 출하된 기능의 델타는 여기 또는 코드 + 살아있는 문서에 기록한다.

---

## 검색(Phase 2) 후속 — 코드 리뷰 지적 (등록 2026-06-27)

검색 설계 스펙 `superpowers/specs/2026-06-26-damwha-search-design.md`에 대한 리뷰에서 나온 5건.
**검색 기능은 이미 구현·머지 완료**이므로, 스펙(동결 스냅샷)이 아니라 실제 `src/search/` 코드를 대조한 뒤 유효성을 확정해야 한다. 아래는 리뷰 지적 원문 기준이며, 각 항목의 상태는 **미확인(코드 대조 선행 필요)**.

| # | 우선 | 위치(스펙) | 지적 | 제안된 수정 | 상태 |
|---|---|---|---|---|---|
| S1 | P1 | L246 (sem arm) | 필터형 HNSW 검색에 `hnsw.ef_search`/iterative scan 미설정. 기본 `ef_search=40` < `cand_k`(기본 100, 최대 500). ANN 필터는 인덱스 스캔 후 적용 → 날짜·참석자 필터 시 결과 심각 부족 가능, `hasMore=false`도 부정확해질 수 있음. | pgvector ≥ 0.8 + `SET LOCAL hnsw.iterative_scan = strict_order`, `ef_search`/`max_scan_tuples` 정책 명시, 필터별 recall 테스트 추가. ([pgvector filtering](https://github.com/pgvector/pgvector#filtering)) | 미확인 |
| S2 | P1 | L318 | 쿼리 벡터를 dimension만 검사하고 model 불일치는 미검증. 동일 1024차원 타 모델 반환 시 서로 다른 벡터공간을 비교하면서 `semantic=true`. | `model === SEARCH_EMBEDDING_MODEL`, 벡터 개수, 각 벡터 길이, NaN/Infinity 검증 후 실패 시 degrade. | 미확인 |
| S3 | P2 | L107 | DB는 `vector(1024)` 고정인데 `IndexMeetingPayload.dimension`/`SEARCH_EMBEDDING_DIM`은 임의 정수 허용. 설정 실수 하나로 색인 잡 영구 실패. | Phase 2에선 `dimension`을 literal `1024`로 제한 + DB `CHECK (dimension = 1024)`, 또는 실제 가변 차원 설계로 전환. | 미확인 |
| S4 | P2 | L238, L282 | keyword·semantic·browse SQL이 `meeting.status='done'` 또는 `u.processing_version = m.processing_version`을 확인 안 함. 재처리 중/실패한 회의의 이전 utterance가 계속 검색됨. | **정책 결정**: 가용성 우선이면 의도를 명시, 최신 확정 결과만이면 두 조건을 SQL에 추가. | 미확인 |
| S5 | P2 | L202 | `/search` 입력 검증 규칙 부재(예시·기본값만). 잘못된 날짜·ID 형식이 DB 오류로 전파 가능. | `limit` 정수 범위, ISO 날짜, ID 형식(^mtg_[1-9][0-9]* 등), 배열 최대 길이, `dateFrom < dateTo`, 검색어 최대 길이 검증 + 실패 시 400 명시. | 미확인 |

다음 단계(이 백로그를 다룰 때): 먼저 `src/search/`(`search.repository.ts`, `search.service.ts`, `search.controller.ts`, `embed.client.ts`)와 `001`/`002` 마이그레이션을 읽어 각 항목의 실제 잔존 여부를 확정 → 유효 항목만 코드 수정 + 이 표 상태 갱신. 스펙 파일은 수정하지 않는다.

---

## 빌드 — 마이그레이션 복사 비멱등 (등록 2026-06-27)

`package.json`의 `build`가 `cp -r src/database/migrations dist/database/migrations`를 쓰는데, `dist/`를 먼저 비우지 않아 **반복 빌드 시 비멱등**이다. `nest-cli.json`에 `compilerOptions.deleteOutDir`가 없어(`nest build` 기본 false) `dist/`가 청소되지 않는다.

- **증상(로컬 증분 빌드):** 1차 빌드는 `dist/database/migrations/`에 정상 안착 → 새 마이그레이션 추가 후 청소 없이 재빌드하면 새 파일이 `dist/database/migrations/migrations/`(중첩)로 들어가고 최상위 사본은 stale → `npm start`의 migrate가 새 마이그레이션을 조용히 누락.
- **영향 범위:** fresh-checkout CI/prod는 기존 `dist/`가 없어 무해. 영향은 특정 마이그레이션이 아니라 **모든 마이그레이션**(증분 로컬 빌드 한정).
- **수정안:** `nest-cli.json`에 `"compilerOptions": { "deleteOutDir": true }` 추가, 또는 build 스크립트를 `rm -rf dist && nest build && cp -r ...`로. (즐겨찾기 003 작업에서 발견, 해당 기능과 무관한 선행 이슈 → 별도 처리.)
- 상태: **미수정**

---

## 워커 — enroll_speaker 빌드 경로 KeyError (등록 2026-06-28)

`enroll_speaker`는 실 워커(`__main__.main()`) 경로에서 **모델 빌드 단계 `KeyError`로 깨진다.** enqueue 측 `buildEnrollSpeakerPayload`(`src/contracts/job-payload.schema.ts`)가 만드는 payload는 `models` 키가 없는데(`speaker_id`/`audio_key`/`embedding`만), `main()`의 비-`index_meeting` 분기가 enroll도 `registry.build_models(payload, settings)`로 처리하고 `build_models`는 첫 줄에서 `m = payload["models"]`를 요구한다.

- **증상:** 실제 enroll job이 워커 main 경로로 돌면 빌드 단계에서 `KeyError: 'models'`. 지금까지 enroll은 `run_enroll_speaker`를 직접 호출하는 유닛테스트(`test_enroll_speaker.py`)로만 검증돼 미발견.
- **현재 완화(2026-06-28 모델-빌드 실패 처리 작업):** 빌드를 `handle_job`의 guarded try 안으로 옮긴 수정으로 이 `KeyError`는 **워커를 죽이지 않고 graceful-fail**(uncategorized→TRANSIENT→requeue 후 attempts 소진 시 `fail_enroll`, speaker `failed`)로 떨어진다. 즉 **크래시-안전성은 확보됐으나 enroll은 여전히 기능적으로 동작하지 않는다.**
- **수정안:** enroll 전용 빌더(예: `registry.build_embedder(payload, settings)` = `EcapaEmbedder(payload["embedding"]["model"], settings.device)`)를 추가하고 `main()`이 enroll 타입엔 이 빌더를 주입. process_meeting은 payload의 device, enroll은 payload에 device가 없으므로 `settings.device` 사용(ECAPA는 내부적으로 CPU — CLAUDE.md 참고). **검증:** fake 모델로는 빌더 선택만 확인 가능하고, enroll이 실제로 voiceprint를 적재하는지는 실모델 smoke 필요.
- 상태: **미수정** (graceful-fail까지만 적용됨)

---

## 렌즈 추출 — 긴 회의가 LLM 컨텍스트를 넘김 (등록 2026-07-22)

`run_extract_lenses`(`worker/damwha_worker/pipeline/extract_lenses.py`)는 회의의 **모든 발화를 한 요청에 담아** LLM에 보낸다. 분할·요약·윈도잉이 없어서 긴 회의는 모델 컨텍스트를 넘겨 실패한다.

- **증상(실측, 2026-07-22):** 997발화·111,030자인 `mtg_3`의 추출 job이 HTTP 400 `input length (420309 tokens) exceeds the model's maximum context`로 실패. 4xx라 PERMANENT로 분류되어 재시도 없이 1회 실패(`lens_client.py`의 상태코드 분기). 분류 자체는 의도대로 동작한 것이며, 실패 지점은 페이로드 크기다.
- **부분 완화(같은 날 `13dd6ae`):** 발화 직렬화를 `ensure_ascii=False`로 바꿔 한글이 `\uXXXX`로 나가지 않게 했다. 이스케이프만으로 토큰이 몇 배 불어 있었으므로 위 420k라는 숫자는 **수정 전 값**이다. 266발화인 `mtg_4`는 이 수정 이후 1회 시도로 성공했다.
- **미확인:** 완화 이후 `mtg_3`가 통과하는지 **측정하지 않았다.** 다음 작업의 첫 단계는 재측정이어야 한다 — 통과하면 이 항목은 "발화 수가 더 많은 회의"로 범위가 좁혀지고, 여전히 실패하면 아래 분할 설계가 필요하다.
- **수정안 후보:**
  - 발화 페이로드 축소: 현재 `id`/`speaker_id`/`speaker_name`/`text`/`start_ms`/`end_ms`를 모두 싣는다. 추출에 불필요한 필드를 빼면 토큰이 줄어든다.
  - 발화를 배치로 나눠 여러 번 호출하고 후보를 병합. **주의:** 배치 경계를 넘는 맥락(앞 발화에서 정해진 담당자 등)이 끊기고, 배치마다 같은 항목이 중복 추출될 수 있다. 병합 규칙(`classifyAiMerge`)은 `(kind, primary utterance)`로 매칭하므로 서로 다른 primary를 가리키는 중복은 걸러지지 않는다.
  - 컨텍스트 초과를 호출 전에 감지해 명시적 오류(또는 자동 분할)로 처리. 지금은 LLM의 400 응답에 의존한다.
- **연관:** 활성 AI 항목은 primary 근거를 반드시 유지해야 하므로(마이그레이션 `014`), 분할 추출을 도입하면 부분 결과 병합이 이 불변식을 깨지 않는지 확인해야 한다.
- **범위:** 로드맵 `superpowers/specs/2026-07-14-lens-platform-roadmap-design.md`의 작업 2(자동 추출 워커) 스펙에 없는 **설계 추가**다. 코드 수정 전에 브레인스토밍→스펙이 필요하다.
- 상태: **미수정**
