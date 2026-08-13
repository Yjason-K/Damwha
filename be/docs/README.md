# Damwha 문서 지도

Damwha는 "누가 언제 무슨 말을 했는지"를 화자 단위로 기록·검색하는 **개인용 회의 기록 플랫폼**이다. 이 디렉터리는 제품 개념부터 백엔드 구현 계획까지를 담는다.

## 읽는 순서

개념(왜·무엇) → 스펙(어떻게 설계) → 플랜(무엇을 만든다) 순으로 좁아진다.

| 문서 | 성격 | 설명 |
|---|---|---|
| [concept.md](./concept.md) | 살아있는 문서 (현재 v0.6) | **서비스 개념 정의서.** 제품 정체성·목표·핵심 기능·화면 구조·핵심 설계 결정. 모든 스펙/플랜이 참조하는 뿌리. |
| [worker-architecture.md](./worker-architecture.md) | 살아있는 문서 | **Python worker 아키텍처.** 전체 구성, 3개 job 처리 흐름, 검색 embed service, 상태·재시도·ownership guard, 운영 방법. |
| [superpowers/specs/2026-06-22-damwha-ingestion-backend-design.md](./superpowers/specs/2026-06-22-damwha-ingestion-backend-design.md) | 스냅샷 | **Phase 1 백엔드 설계 스펙.** 인제스션 백엔드(스키마·작업 큐·업로드·ML 워커 계약)의 확정 설계. |
| [superpowers/plans/2026-06-22-damwha-ingestion-api.md](./superpowers/plans/2026-06-22-damwha-ingestion-api.md) | 스냅샷 | **Phase 1 / Plan 1 실행 플랜.** 스펙을 작업 단위로 분해한 NestJS API(`src/`)의 구현 계획. |
| [superpowers/specs/2026-06-23-damwha-ml-worker-design.md](./superpowers/specs/2026-06-23-damwha-ml-worker-design.md) | 스냅샷 | **Phase 1 / Plan 2 설계 스펙.** `job` 계약을 소비하는 Python ML 워커(VAD→화자식별→STT→정렬, ownership 가드)의 설계. |
| [superpowers/plans/2026-06-23-damwha-ml-worker.md](./superpowers/plans/2026-06-23-damwha-ml-worker.md) | 스냅샷 | **Phase 1 / Plan 2 실행 플랜.** Python ML 워커(`worker/`)의 구현 계획. 실제 모델 검증 절차는 `../worker/SMOKE.md`. |
| [superpowers/specs/2026-07-14-lens-platform-roadmap-design.md](./superpowers/specs/2026-07-14-lens-platform-roadmap-design.md) | 스냅샷(진행 상태 갱신) | **Phase 3 렌즈 플랫폼 작업 분할.** 작업 1(기반 서비스)·2(추출 워커)·3(전역 대시보드)은 완료, 작업 4(주제·키워드 저장 렌즈)가 남았다. 각 작업의 완료 결과·커밋·설계 문서 링크가 여기 모인다. |

> Phase 1 백엔드는 두 런타임으로 나뉜다: **Plan 1 = NestJS API(`src/`)**, **Plan 2 = Python 워커(`worker/`)**. 둘은 Postgres `job` 테이블로만 통신한다. 아키텍처·불변식·명령어는 리포 루트 `CLAUDE.md` 참조(살아있는 문서).

## 문서 종류

- **살아있는 문서 (`concept.md`, `worker-architecture.md`, `backlog.md`)** — 계속 개정된다. 경로는 고정하고, 버전·작성일은 문서 헤더와 git 히스토리로 추적한다. 다른 문서는 이 경로를 참조한다. [`backlog.md`](./backlog.md)는 출하 후 발견된 후속 이슈를 모은다.
- **보고서 (`reports/`)** — 조사·측정의 결과 기록. 특정 시점의 관찰이므로 파일명에 날짜를 박고, 본문은 고쳐 쓰지 않는다. 스펙/플랜과 달리 "무엇을 만들까"가 아니라 "무엇을 발견했나"를 담는다. **후속 측정이 결론을 뒤집으면 원문을 남긴 채 날짜를 단 후속 장을 덧붙이고, 뒤집힌 문장에 그 장을 가리키는 정정을 단다** — 조사가 어디서 틀렸는지가 결론만큼 쓸모 있기 때문이다. 운영 절차로 굳은 내용은 `../worker/SMOKE.md`나 살아있는 문서로 옮긴다.
  - [reports/2026-08-13-stt-repetition-loop.md](./reports/2026-08-13-stt-repetition-loop.md) — Qwen3-ASR 도입 검토 중 발견한 Whisper 반복 루프의 원인 규명과 수정.
- **스냅샷 (`superpowers/specs`, `superpowers/plans`)** — 특정 시점의 합의를 기록한 산출물이라 파일명에 날짜(`YYYY-MM-DD-`)를 박는다. superpowers 워크플로(브레인스토밍→스펙→플랜)의 출력물 네임스페이스다. 적용된 스펙/플랜은 수정하지 않고 새 문서를 추가한다. **예외:** 여러 작업을 묶는 로드맵 문서(예: 렌즈 플랫폼 로드맵)는 설계를 고쳐 쓰지 않되 각 작업의 완료 상태·결과·커밋만 덧붙인다.

## 페이즈 개요

백엔드는 한 번에 구축하기엔 커서 페이즈로 분해한다. (상세: 스펙 0장)

| # | 이름 | 산출물 |
|---|---|---|
| **1** | 인제스션 백엔드 (이 코드베이스) | 업로드한 회의가 화자 귀속된 발언 타임라인으로 저장·조회됨 |
| 2 | 검색 | 한국어 FTS + 의미검색 + 복합검색 API |
| 3 | 렌즈·추출 | 로컬 LLM 추출 + 비파괴 재추출 머지 + 회의별/전역 뷰 (작업 1–3 완료, 주제 저장 렌즈 남음) |
| 후 | 확장 | 공유·내보내기 가드레일, 회의 그래프 |
