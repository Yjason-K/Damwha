# 빈 utterance 처리 개선 설계

날짜: 2026-07-08
범위: FE 전용 (BE/worker/DB 변경 없음)

## 문제

회의 상세 화면 트랜스크립트에 텍스트가 없는 행(스피커 칩 + 타임스탬프만)이 다수 노출된다.

원인 체인:

1. worker `align.py` `build_utterances()` — diarization 구간에 STT 단어가 하나도 붙지 않으면 `text=None`, `status="silence"` 또는 `"transcribe_failed"`인 utterance를 그대로 저장한다.
2. BE `meetings.repository.ts` `findUtterances()` — status/text 필터 없이 전부 반환한다.
3. FE `mappers.ts` `toMeetingDetail()` — `text: u.text ?? ""`로 매핑하고 `status` 필드를 버린다. FE는 빈 행을 구분할 수 없다.
4. `transcript-pane.tsx`가 전부 렌더 → 빈 행 노출. 하단 타임라인(`meeting.tracks`)과 발화시간 집계도 같은 데이터를 사용해 silence 구간이 발화로 잡힌다.

## 결정 사항

- **silence**: FE 매퍼에서 제거. 트랜스크립트 목록, 타임라인 막대, 발화시간 집계 모두에서 제외.
- **transcribe_failed**: 목록에 유지하되 플레이스홀더 텍스트("전사하지 못한 구간입니다", 회색 이탤릭)로 표시. 스피커 칩·타임스탬프·"원문 보기"(오디오 점프) 버튼 유지. 타임라인 막대·발화시간에도 포함(실제 발화였고, 목록↔타임라인 일관성 유지).
- **필터 위치**: FE 매퍼(`toMeetingDetail`). BE API는 원본 데이터를 그대로 반환해 향후 "전체 보기" 류 기능의 여지를 남긴다.

## 변경 내용

### 1. 데이터 레이어

`fe/src/features/meeting/model/types.ts` — `UtteranceEntry`에 `status: UtteranceStatus` 필드 추가.

`fe/src/features/meeting/api/mappers.ts` — `toMeetingDetail()`:

- 매핑 전 필터: `status === "silence"` 제외. 방어적으로 `status === "ok"`이면서 text가 비어 있는 행도 제외.
- `status`가 undefined인 wire 데이터는 `"ok"`로 취급한다(빈 text면 위 필터로 제거됨).
- `transcribe_failed`는 통과시키고 `status`를 domain entry에 보존한다. text는 `""` 유지.
- `tracks` 파생을 필터링된 목록 기준으로 계산한다. silence가 타임라인 막대와 `spokenMs` 집계에서 자동 제외된다.

### 2. 렌더링

`fe/src/features/meeting/ui/transcript-pane.tsx` — `status === "transcribe_failed"`인 entry는 텍스트 children 대신 플레이스홀더를 렌더한다.

`fe/src/shared/ui/utterance.tsx` — `placeholder?: boolean` prop 추가. true면 텍스트를 회색 이탤릭으로 표시한다. 스피커 칩, 타임스탬프, "원문 보기" 버튼 동작은 기존과 동일.

플레이스홀더 문구: `전사하지 못한 구간입니다`

렌더 예시:

```
03:26  [규니규니]  전사하지 못한 구간입니다        [↗ 원문 보기]
                 (회색 이탤릭)
```

### 3. 엣지 케이스

- 회의 전체가 silence → `utterances`가 빈 배열. 기존 빈 상태 UI가 그대로 동작하는지 구현 시 확인한다.
- 화자별 utterance가 전부 silence로 필터되면 해당 화자의 타임라인 레인은 막대 없이 렌더된다(발화시간 0). 참석자 목록에서 화자를 제거하지는 않는다.

## 테스트

매퍼 유닛 테스트 (`toMeetingDetail`):

- silence utterance가 결과에서 제거된다.
- transcribe_failed utterance가 통과하고 `status`가 보존된다.
- `status === "ok"`이면서 text가 빈 행이 제거된다.
- `status` undefined + text 있는 행은 `"ok"`로 통과한다.
- `tracks` 막대와 `spokenMs`에 silence 구간이 포함되지 않는다.

컴포넌트 테스트:

- transcribe_failed 행이 플레이스홀더 문구를 회색 이탤릭으로 렌더한다.
- 플레이스홀더 행에도 "원문 보기" 버튼이 존재한다.
