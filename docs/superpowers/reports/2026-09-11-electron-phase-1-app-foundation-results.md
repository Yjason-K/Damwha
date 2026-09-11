# Electron Phase 1 — 앱 기반 실행 결과

작성 시작: 2026-09-11
브랜치: `feat/electron-migration-phase-1-app-foundation`
브랜치 분기점: `a4f3a99` (`dev`)
스펙: [2026-09-11-electron-phase-1-app-foundation-design.md](../specs/2026-09-11-electron-phase-1-app-foundation-design.md)
계획: 미작성

**상태 (2026-09-11): 스펙 리뷰 통과. 구현 계획 작성 전.**

## 스펙 리뷰

| 회차 | 대상 버전 | 검토자 | 지적 | 조치 | 통과 |
| --- | --- | --- | --- | --- | --- |
| 1 | 초안 (미커밋) | 메인 세션 (자체 검토) | 4건 — 준비 판정을 `/api/health` 하나로 둔 오류, P1-C8의 실패 유발 경로가 P1-C7과 동일, `pnpm deploy` 호출 형식과 Experimental 상태 누락, P1-C11의 "심볼릭 링크 0개"가 과한 기준 | 전건 반영 후 `bc33b7f`로 커밋 | 통과 |
| 2 | `bc33b7f` | Codex (`codex:rescue`) | F-1 ~ F-10 (차단 5, 비차단 5). 판정 NEEDS CHANGES | F-1·F-2·F-3·F-4·F-5·F-6·F-7·F-8 반영, F-9 부분 반영, F-10 확인만 | 통과 |

리뷰어에게는 스펙·로드맵·Phase 0 결과 문서와 코드만 주었고 설계 대화를 주지 않았다 (로드맵 "리뷰어는 구현 대화를 받지 않고 diff·스펙·계획·검증 증거만으로 판단한다").

### 1회차 지적 상세 — 메인 세션 자체 검토

| ID | 지적 | 조치 |
| --- | --- | --- |
| S-1 | 준비 판정을 `GET /api/health` 하나로 뒀으나, `be/src/database/database.service.ts:34`가 fail-fast라 DB 미기동 시 API가 listen하지 않는다. 503은 기동 시점에 관찰되지 않는다 | 판정 신호를 health + 자식의 종료 코드·stderr 둘로 고쳤다. `maskUrl`이 비밀번호를 가리므로 `database unreachable at …` 원문을 화면에 올려도 된다는 근거를 함께 적었다 |
| S-2 | P1-C8이 잘못된 `DATABASE_URL`로 기동 실패를 유발해 P1-C7과 같은 경로를 밟는다 | 카탈로그 밖 `SUMMARY_LLM_MODEL`로 바꿨다. zod 단계에서 죽어 문안이 달라지므로 main이 고정 문구가 아니라 실제 stderr를 올린다는 것을 판정한다 |
| S-3 | `pnpm deploy` 호출 형식이 문서와 다르고(`pnpm --filter=<pkg> deploy <dir>`), pnpm 10.26.0에서 Experimental이라는 사실이 빠졌다 | 형식을 바로잡고 `--legacy`·`--config.node-linker=hoisted` 대안을 적었다. R1-9로 등재 |
| S-4 | P1-C11의 "심볼릭 링크 0개"가 과하다. `node_modules/.bin`처럼 트리 안을 가리키는 링크는 재배치를 깨지 않는다 | 기준을 "트리 밖을 가리키는 링크 0건"으로 바꿨다 |

### 2회차 지적 상세 — Codex

| ID | 차단 | 지적 | 조치 |
| --- | --- | --- | --- |
| F-1 | 차단 | 기본 `config.json`은 API의 `STORAGE_ROOT`를 `<userData>/storage`로 두는데 worker의 기본값은 `be/storage`다. 기본 설정으로 실행하면 worker가 파일을 못 찾아 처리가 실패한다. 스펙은 검증 때만 수동으로 맞추라고 적었다 | **사용자에게 방향을 확인해 worker를 앱 값에 맞추기로 결정.** 기본값 `<userData>/storage`를 유지하고 선행 조건 3번을 "`be/worker/.env`의 `STORAGE_ROOT`를 앱 값과 같은 절대 경로로" 로 고쳤다. §6.3에 방향 선택의 근거 3개와 대가(기존 회의 오디오 404, Phase 5에서 해소)를 적었다. 검증은 기본값으로 수행한다 |
| F-2 | 차단 | 오류 셸이 "재시도"를 제공해야 하는데 preload가 없어 렌더러에서 main을 부를 IPC 경로가 없다. 구현자가 임의로 해석하게 된다 | §6.5에 재시도 소유자를 main으로 고정했다. 자동 재시도(백오프) + 애플리케이션 메뉴 항목 — 메뉴는 main 소유라 IPC가 필요 없다. 셸은 표시만 한다. "렌더러→main 경로를 새로 만들지 않는다"를 계약으로 명시 |
| F-3 | 차단 | 루트 `dev`가 `pnpm --parallel --recursive run dev`라 `desktop`에 `dev` 스크립트를 두면 `pnpm dev`가 Electron을 띄운다. "기존 웹 흐름과 공존"이 그 자리에서 깨진다 | §6.1에 스크립트 이름 표를 넣었다. `start:desktop`·`package:desktop`은 recursive에 참여하지 않고 루트가 `--filter`로만 부른다. `lint`·`test`는 참여한다. `build`도 같은 문제라는 것을 함께 적었다. P1-C13의 판정에 추가 |
| F-4 | 차단 | 로드맵이 "정상 종료와 자식 프로세스 정리"와 "자식 프로세스가 종료 후 남지 않음"을 Phase 2 범위·완료 기준에 두는데 스펙이 Phase 1에서 구현·판정한다. Phase 경계가 이중 정의다 | §6.2에 경계 표를 넣고, **로드맵을 갱신했다** — Phase 1 범위에 "앱이 만든 자식(API 하나)의 종료 정리"를 명시하고, Phase 2의 해당 항목을 "Phase 1이 세운 절차를 전체 서비스로 확장"으로 다시 썼다. 근거: 자식을 만들면서 정리를 미루면 Phase 1 산출물이 프로세스를 흘린다 |
| F-5 | 차단 | 기존 `be/storage`를 덮어쓰지 않는다는 데이터 안전 규칙에 검증 기준이 없다. P1-C2는 새 업로드 성공만, P1-C12는 `.app` 내부 쓰기만 본다 | **P1-C14 신설.** 앱 실행 전후 `be/storage` 파일 목록·체크섬 전량 비교, 기존 `meeting`·`utterance` 행 수 비교, compose `name`·`damwha_pgdata` 볼륨 비교, `_migrations` 행 수 비교. §5에 "각 규칙은 P1-C14가 실측으로 판정한다"를 명시 |
| F-6 | 비차단 | dotenv 서술은 정확하나 자식의 `cwd`와 entrypoint가 확정되지 않아 어느 `.env`가 읽히는지가 구현자 판단에 남는다 | §6.3에 dev·packaged 각각의 entrypoint·cwd·읽히는 `.env`·값의 출처·로그 위치를 표로 고정했다 |
| F-7 | 비차단 | "`001_init.sql`은 `original_filename`만 저장한다"가 사실과 다르다. `meeting`은 `audio_key`(`NOT NULL`)와 `normalized_key`도 저장한다 | 확인 결과 지적이 맞다(`001_init.sql:39-40`). 서술을 "DB는 상대 storage key를 저장하고 API·worker가 각자 root에서 해석한다"로 바로잡고, 스키마가 `CHECK`로 강제하지 않으므로 **상대 키만 저장한다는 것은 서비스 계약**임을 명시했다 |
| F-8 | 비차단 | 포트 탐색과 자식 bind 사이 경쟁 조건이 있고, 같은 포트의 외부 API를 자기 것과 구별하는 규칙이 없다 | §6.4를 다시 썼다. 판정을 자식의 bind 결과로 바꿨다 — 고정 포트로 기동 → `EADDRINUSE`면 다음 후보로 재기동 → 상한 N. 소유권은 자식 프로세스 핸들과 pid로만 판정하고 "그 포트에 응답이 있다"를 준비 신호로 쓰지 않는다. R1-10·R1-11 등재, P1-C10 판정 강화 |
| F-9 | 비차단 (부분 수용) | `HOST=127.0.0.1`은 LAN 노출을 막지만 API가 무제한 CORS를 켠다. 위협 모델이 정의되지 않았다 | **Phase 1에서 고치지 않는다.** 남은 위협은 같은 머신의 다른 프로세스이고 그것은 CORS 정책으로 막히지 않는다(CORS는 브라우저의 규칙이고 API에 인증이 없다). 데스크톱이 되면서 새로 생기는 노출이 아니다. §6.6에 알려진 제약으로 적고 §15에서 Phase 6 배포 보안 검토로 인계했다 |
| F-10 | 비차단 | 코드 주장 6건(dotenv import 순서, fail-fast, 상대 key, `HOST` 기본값, SPA 폴백, 브라우저 `getUserMedia`)은 확인 결과 정확 | 변경 없음. 계획에서 각 주장을 검증 항목으로 연결한다 |

### 2회차 이후 스펙 상태

- 신설 완료 기준: P1-C14 (기존 데이터 보존).
- 신설 위험: R1-9 (`pnpm deploy` Experimental), R1-10 (`EADDRINUSE` 구분 실패), R1-11 (외부 API 오인).
- 로드맵 변경 3곳: Phase 1 범위에 자식 정리 추가, Phase 2 범위·완료 기준의 해당 항목을 확장으로 재서술, Phase 1 상태 기록.

## 계획 검증

미실시.

## 단계별 실행·리뷰

미실시.

## 최종 검증

미실시.

## 남은 제약·후속 Phase 인계

스펙 §15가 현재 상태를 담는다. 구현이 끝나면 실제 결과로 갱신한다.
