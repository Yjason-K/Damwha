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
- **파생 데이터 분리**: 화자 식별(spk 번호)·speakers·attendees·clusters는 **전체 utterance**(silence 포함)에서 파생한다. 트랜스크립트 목록(utteranceEntries)과 tracks의 막대(segments)·발화시간(spokenMs)만 **필터링된 목록**에서 파생한다. 발화가 전부 silence인 화자도 참석자 목록과 타임라인 레인에는 남는다(막대 없음, 발화시간 0).
- **"빈 text" 기준**: `text == null || text.trim() === ""` (whitespace-only 포함).
- **검색(⌘K)은 범위 제외**: BE 검색이 모든 경로(LIKE·임베딩·브라우즈)에서 `u.status='ok' AND u.text IS NOT NULL`을 이미 필터한다(`be/src/search/search.repository.ts:57,104,124`). 빈 히트는 BE에서 차단되므로 FE 검색 매퍼 변경 불필요.
- **전체 silence 회의의 빈 로그 영역은 허용**: 트랜스크립트 목록이 빈 배열이면 로그 영역이 비어 보인다. 극히 드문 케이스이므로 별도 빈 상태 UI는 추가하지 않는다(YAGNI). 필요해지면 후속 작업.

## 변경 내용

### 1. 데이터 레이어

`fe/src/features/meeting/model/types.ts` — `UtteranceEntry`에 `status: UtteranceStatus` 필드 추가.

`fe/src/features/meeting/api/mappers.ts` — `toMeetingDetail()`:

- 정렬된 전체 목록(`allUtterances`)과 표시용 목록(`visibleUtterances`)을 분리한다.
  - `visibleUtterances` = `allUtterances`에서 `status === "silence"` 제외, 그리고 `status === "ok"`이면서 text가 빈(`text == null || text.trim() === ""`) 행 제외.
  - `spkOf`(화자 번호), `sampleBySpk`, `speakers`, `attendees`, clusters 파생은 기존대로 `allUtterances` 기준 — 화자·참석자가 필터로 사라지지 않는다.
  - `utteranceEntries`와 `tracks`의 `segments`·`spokenMs`는 `visibleUtterances` 기준.
- `transcribe_failed`는 통과시키고 `status`를 domain entry에 보존한다. text는 `""` 유지.
- `WireUtterance.status`는 필수 필드이므로(`api/types.ts:53`) undefined 방어 로직은 두지 않는다.

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

- 회의 전체가 silence → `utterances`가 빈 배열, 로그 영역이 비어 보인다. 결정 사항대로 별도 빈 상태 UI 없이 허용한다.
- 화자별 utterance가 전부 silence로 필터되면 해당 화자의 타임라인 레인은 막대 없이 렌더된다(발화시간 0). 참석자 목록에서 화자를 제거하지는 않는다(allUtterances 기준 파생이므로 자동 보장).

## 테스트

매퍼 유닛 테스트 (`toMeetingDetail`):

- silence utterance가 결과에서 제거된다.
- transcribe_failed utterance가 통과하고 `status`가 보존된다.
- `status === "ok"`이면서 text가 빈 행(null·""·whitespace-only)이 제거된다.
- `tracks` 막대와 `spokenMs`에 silence 구간이 포함되지 않는다.
- 발화가 전부 silence인 화자도 `speakers`/`attendees`/`tracks` 레인에 남는다(막대 0개, dur 0).

컴포넌트 테스트:

- transcribe_failed 행이 플레이스홀더 문구를 회색 이탤릭으로 렌더한다.
- 플레이스홀더 행에도 "원문 보기" 버튼이 존재한다.
