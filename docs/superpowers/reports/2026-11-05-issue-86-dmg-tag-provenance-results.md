# 발행할 DMG의 소스 출처 검증 결과

**작성일:** 2026-11-05
**Spec:** [발행할 DMG의 소스 출처 검증 설계](../specs/2026-11-05-issue-86-dmg-tag-provenance-design.md)
**Plan:** [구현 계획](../plans/2026-11-05-issue-86-dmg-tag-provenance.md)
**브랜치:** `fix/issue-86-dmg-tag-provenance`
**기준:** `dev` @ `4bac4a89`, 수정 커밋 `7e35e20b`

## 변경

- `desktop/scripts/lib/release-provenance.mjs`(신규): `assertReleaseBuildInfo`(버전 일치, `-dirty` 거절,
  12자 커밋이 태그 커밋의 접두사인지), `provenanceFor`, `readDmgBuildInfo`
  (`hdiutil attach -readonly -nobrowse -mountpoint <임시>` → 읽기 → detach), `verifyRelease`, CLI `verify`.
- `desktop/scripts/publish.sh`: 해시 검사(4번) 뒤 4b로 위 CLI를 부르고, 업로드 자산에
  `<dmg>.provenance.json`을 더했다.
- `desktop/scripts/package.mjs`: `--release`일 때 build-info를 쓰는 자리에서 dirty 빌드를 거절하고,
  DMG `sha256` 뒤에 provenance 파일을 쓴다.
- `desktop/CLAUDE.md` 서명·배포 절에 다섯 번째 검사와 provenance 자산을 적었다.

## 회귀 재현 (RED → GREEN)

`desktop/tests/scripts/publish.test.ts`는 임시 git 저장소와 로컬 bare origin에 `v9.9.9` 태그를 두고,
PATH 앞의 가짜 `gh`(인자 기록)와 가짜 `hdiutil`로 `publish.sh`를 끝까지 돌린다. `GH_TOKEN`·
`GH_CONFIG_DIR`도 가짜다. 실제 발행·태그 푸시·패키징·공증은 하지 않았다.

- 수정 전: 7개 중 7개 실패. 거절해야 할 6개(예전 커밋 빌드, build-info만 다른 커밋, dirty 빌드,
  provenance 없음, provenance 커밋 불일치, provenance 해시 불일치)가 모두 `gh release create`까지
  갔다. 정상 경우는 provenance 자산이 없어서 실패했다.
- 수정 후: 7개 모두 통과.

## 검증

| 명령 | 결과 |
|---|---|
| `pnpm exec vitest run tests/scripts/publish.test.ts tests/scripts/release-provenance.test.ts` (desktop) | 2개 파일, 13개 테스트 통과 |
| `pnpm --filter damwha-desktop test` | 87개 파일 통과·1개 skip, 1527개 통과·3개 skip |
| `pnpm --filter damwha-desktop run lint` (`tsc -p tsconfig.lint.json`) | rc 0 |
| `bash -n desktop/scripts/publish.sh` | 통과 |
| `node --check` (`package.mjs`, `release-provenance.mjs`) | 통과 |
| 작은 실제 DMG(`hdiutil create -srcfolder`)에 `release-provenance.mjs verify` | 일치 rc 0, 커밋 불일치 rc 1, 남은 마운트 0 |

`package.mjs --release` 전체 실행(서명·공증·DMG)은 하지 않았다. 그 경로의 변경은 `node --check`와
같은 규칙 함수의 단위 테스트로만 확인했다.

## 알려진 한계

- build-info의 커밋은 12자 약칭이라 DMG 안 판독은 접두사 대조다. 40자 대조는 provenance가 맡는다.
- provenance 파일은 DMG와 같은 빌드가 쓰므로 위조를 막는 서명이 아니다. 같은 저장소에서 만든
  산출물의 출처를 대조하고 외부에서 다시 확인할 수 있게 남기는 기록이다.

## 완료 기준 판정

| 기준 | 판정 |
|---|---|
| C1 DMG 안 build-info를 태그 커밋과 대조 | 충족 — `readDmgBuildInfo` + `assertReleaseBuildInfo`, 테스트 "build-info만 다른 커밋" |
| C2 다른 커밋·dirty 빌드 거절, 개발 정책 유지 | 충족 — publish·`package.mjs --release` 양쪽. `check-bundle`과 `package:desktop`은 그대로 |
| C3 소스 커밋–DMG 해시 메타데이터 | 충족 — `<dmg>.provenance.json`, 발행 때 검증 뒤 자산 업로드 |
| C4 외부 발행 없는 허용/거절 테스트 | 충족 — `publish.test.ts` 7건 |
| C5 기록과 dev 대상 PR | 충족 — 본 문서와 PR |
