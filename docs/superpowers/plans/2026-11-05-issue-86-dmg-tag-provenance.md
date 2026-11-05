# 이슈 #86 구현 계획

**Spec:** [발행할 DMG의 소스 출처 검증 설계](../specs/2026-11-05-issue-86-dmg-tag-provenance-design.md)
**작성일:** 2026-11-05
**기준:** `dev` @ `4bac4a89`

## 1. 회귀 재현 (RED)

- `desktop/tests/scripts/publish.test.ts`: 임시 git 저장소(+ 로컬 bare origin)에 `publish.sh`와
  `scripts/lib`를 복사하고 `v<version>` 태그를 양쪽에 둔다. PATH 앞에 가짜 `gh`(인자 기록)와
  가짜 `hdiutil`(`-mountpoint`에 가짜 `Damwha.app`을 채움)을 둔다. `GH_TOKEN`·`GH_CONFIG_DIR`도
  가짜로 덮어, 실제 gh가 불려도 인증에서 실패하게 한다.
- 경우: 정상 빌드(통과, provenance 자산 포함), 다른 커밋의 빌드, dirty 빌드, provenance 없음,
  provenance 해시 불일치(모두 거절, `gh release create` 미호출).
- 수정 전 실행에서 거절해야 할 경우들이 `gh release create`까지 가는 것을 확인한다.

## 2. 수정 (GREEN)

- `scripts/lib/release-provenance.mjs`: `assertReleaseBuildInfo`, `provenanceFor`,
  `readDmgBuildInfo`(`hdiutil attach -readonly -nobrowse -mountpoint <임시>` → 읽기 → detach),
  `verifyRelease`, CLI `verify <dmg> <version> <commit>`.
- `publish.sh` 4번 뒤에 CLI 호출, 업로드 자산에 provenance 추가, 머리 주석 갱신.
- `package.mjs`: 릴리스면 build-info 기록 전에 `assertReleaseBuildInfo`, sha256 뒤에 provenance 기록.
- 단위 테스트로 `assertReleaseBuildInfo` 규칙을 고정한다.

## 3. 검증과 기록

- `pnpm --filter damwha-desktop test`, `pnpm --filter damwha-desktop run lint`,
  `bash -n desktop/scripts/publish.sh`, `node --check`(변경한 .mjs).
- `desktop/CLAUDE.md` 갱신, 결과 문서, dev 대상 PR.
