# 발행할 DMG의 소스 출처 검증 설계

**작성일:** 2026-11-05
**선행:** `dev` @ `4bac4a894db81c58e27b0a05812c9921d505b31b`
**작업 브랜치:** `fix/issue-86-dmg-tag-provenance`
**이슈:** #86
**대체:** 기존 설계를 대체하지 않는다. Phase 6a 스펙 §7.1의 `publish.sh` 발행 전 검사에 한 단계를 더한다.

## 문제

`publish.sh`는 작업 트리·로컬 태그·원격 태그가 모두 HEAD와 같은지 보고, `out/`의 DMG가
옆의 `.sha256`과 맞는지만 본다. DMG **안의** 빌드가 어느 커밋에서 나왔는지는 보지 않는다.
`package.mjs`가 `Resources/build-info.json`에 `commit`(12자, 더러우면 `-dirty`)을 적지만
발행 경로에서는 아무도 읽지 않는다. 그래서 같은 버전의 예전 커밋 빌드나 dirty 빌드가 자기
체크섬과 함께 `out/`에 남아 있으면, 태그만 맞춘 상태로 그대로 발행된다.

끊긴 고리는 둘이다. **태그 → 커밋**은 검사한다. **커밋 → DMG 안의 build-info**는 검사하지 않는다.
**DMG 해시 → 커밋**은 이어 주는 기록이 없다.

## 목표

- 발행 직전에 DMG를 마운트해 안의 `build-info.json`을 읽고, 버전과 커밋이 릴리스 태그의
  커밋과 같은지 대조한다. 다르거나 `-dirty`면 아무것도 내지 않는다.
- `package.mjs --release`도 dirty 빌드를 빌드 식별자를 쓰는 시점에 거절한다. 개발용 빌드
  (`package:desktop`)와 `check-bundle`의 `-dirty` 허용은 그대로 둔다.
- 릴리스 빌드는 DMG 옆에 `Damwha-<version>-arm64.dmg.provenance.json`
  (`version`·`tag`·40자 `commit`·`dmg`·`sha256`)을 남긴다. `publish.sh`는 이 파일이
  태그 커밋·실제 DMG 해시와 맞는지 확인하고 릴리스 자산으로 함께 올린다.

## 범위

- `desktop/scripts/lib/release-provenance.mjs`(신규): 검증 규칙, DMG 마운트 판독, CLI 진입점.
- `desktop/scripts/package.mjs`: 릴리스일 때 dirty 거절, provenance 파일 기록.
- `desktop/scripts/publish.sh`: 4번 검사 뒤 provenance·DMG 내부 검증, 업로드 자산에 provenance 추가.
- `desktop/tests/scripts/publish.test.ts`(신규): 가짜 `gh`·`hdiutil`과 임시 git 저장소로
  `publish.sh`를 끝까지 돌린다. 실제 발행·태그 푸시·패키징은 하지 않는다.
- `desktop/CLAUDE.md` 서명·배포 절의 `publish.sh` 설명.

## 범위 밖

`build-info.json` 형식 변경(앱의 판올림 판정이 읽는다), `check-bundle.mjs`의 dirty 허용
변경, 이미 발행된 릴리스의 재검증, `desktop/src` 변경.

## 완료 기준

- C1 발행 전 실제 DMG 안의 `build-info.json` 버전·커밋을 릴리스 태그 커밋과 대조한다.
- C2 다른 커밋 또는 dirty 빌드의 발행을 거절한다. 개발용 패키징과 `check-bundle`의 정책은 바뀌지 않는다.
- C3 소스 커밋과 DMG 해시를 잇는 provenance 파일을 남기고, 발행 때 검증한 뒤 자산으로 올린다.
- C4 실제 외부 발행 없이 오래된 빌드·dirty 빌드·provenance 불일치는 거절되고 정상 빌드는 허용됨을 테스트한다.
- C5 spec·plan·result를 남기고 dev 대상 PR을 만든다.
