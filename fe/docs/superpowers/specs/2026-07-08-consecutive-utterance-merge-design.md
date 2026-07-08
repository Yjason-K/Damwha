# 연속 같은 화자 발화 병합 설계

날짜: 2026-07-08
범위: FE 전용 (BE/worker/DB 변경 없음)
선행: `2026-07-08-empty-utterance-handling-design.md` (silence 필터 + status 보존) 구현 완료 기준.

## 문제

트랜스크립트에서 같은 화자가 이어서 말한 짧은 발화들이 행 단위로 잘게 쪼개져 표시된다
(예: "괜찮을" / "것 같긴 합니다" / "어... 그리고 이제..."). diarization 구간 단위로
utterance가 생성되고 FE가 연속 병합 없이 전부 개별 행으로 렌더하기 때문. 가독성이 나쁘다.

## 결정 사항

- **텍스트 병합**: 연속된 같은 화자의 발화를 하나의 문단 entry로 이어붙여 표시한다
  (시각적 그룹핑이 아니라 텍스트 자체를 합침).
- **병합 위치는 FE 매퍼** (`toMeetingDetail`): 원본 데이터·검색 인덱스·화자 resolve는
  발화 단위를 유지하고 표시만 병합한다. silence 필터와 같은 레이어.
- **시간 간격 무관**: 연속이기만 하면 간격과 상관없이 병합한다 (임계값 없음 —
  브레인스토밍에서 시간 임계값 병합안을 검토 후 명시적으로 배제한 확정 결정.
  장시간 단일 화자 회의에서 문단이 과도하게 길어지는 문제가 실사용에서 확인되면
  표시 단위 제한을 후속 검토한다).
- **추적성 보존**: 병합 entry는 구성 발화의 id·시각 목록(`sources`)을 보존한다.
  utterance-jump(발화 → 원본 오디오 시점)가 제품 시그니처이므로, 검색 히트가 블록
  중간 발화를 가리켜도 그 발화의 정확한 시점으로 seek해야 한다. 블록 시작으로
  뭉개지 않는다.

## 병합 규칙

`visibleUtterances`(silence·빈 text 필터 후)를 순회하며:

- 연속된 같은 화자(spk)의 `status === "ok"` 발화를 하나의 entry로 병합한다.
  각 발화 텍스트를 trim한 뒤 공백(`" "`) 한 칸으로 이어붙인다.
- `transcribe_failed`는 병합하지 않는다 — 플레이스홀더 렌더링이 다르므로 단독 entry로
  남고, 블록 경계로 작동한다. `[ok A, failed A, ok A]` → entry 3개.
- 화자(spk)가 바뀌면 새 블록.
- 표시 타임스탬프(`t`)는 블록 첫 발화의 시각.

## 타입 변경

`UtteranceEntry`(`fe/src/features/meeting/model/types.ts`)에 추가:

```ts
sources: { id: string; startMs: number }[];
```

- 구성 발화의 id와 원본 `start_ms`, 병합 순서대로. 병합되지 않은 entry(단독 발화,
  transcribe_failed)는 원소 1개.
- `startMs`를 보존하는 이유: 표시 문자열 `t`는 `formatClock`이 초 단위로 floor해
  ms 정밀도가 사라진다. seek은 `startMs` 기준으로 해야 "정확한 시점 seek" 계약을
  지킨다.
- 불변식: `id === sources[0].id`, `t === formatClock(sources[0].startMs)`.
- `status`는 기존 유지 — 병합 entry는 항상 `"ok"`(failed는 병합 안 되므로).

## 소비처 변경

### `fe/src/pages/meeting.tsx`

- `jumpTo`: `meeting.utterances.find((x) => x.id === uid)` → sources 검색으로 변경.
  매칭된 **source의 `startMs`** 로 seek한다(`startMs / 1000 / totalSeconds` 비율).
  블록의 `t`가 아니다.
- `pendingSeek` 처리(onLoadedMetadata 경로)도 동일하게 sources 검색 + source
  `startMs` seek.
- `setActiveId(uid)`는 그대로 원본 발화 id를 저장한다.

### `fe/src/features/meeting/ui/transcript-pane.tsx`

- active 판정: `activeId === u.id` → `u.sources.some((s) => s.id === activeId)`.
- 스크롤 타깃: `data-uid`는 블록 id(`u.id`) 유지. activeId(원본 발화 id)로 스크롤할
  때는 activeId를 포함하는 블록의 id로 해석한 뒤 해당 `data-uid` 요소로 스크롤한다.
- "원문 보기" 버튼: 블록의 `id`(첫 발화)로 점프. **의도된 UX** — 이 버튼은 "표시된
  행(블록)의 원본 듣기"이므로 블록 시작이 올바른 대상이다. 검색 히트처럼 블록 중간
  발화를 가리키는 정밀 점프는 검색 경로(sources 매핑)가 담당한다. active source가
  블록 내부에 있어도 버튼은 블록 시작으로 점프한다.

### 변경하지 않는 것

- `tracks`(타임라인 막대)·`spokenMs`(발화시간): 병합 **전** `visibleUtterances` 기준
  그대로. 막대는 실제 발화 구간을 반영하는 게 맞다.
- 검색(⌘K): BE가 발화 단위로 반환 — 그대로. 히트 클릭 시 위 sources 매핑으로 블록을
  찾아 점프한다.
- `quoted` 필드: 현재 API 경로에서 설정되지 않음. 병합 로직은 status만 본다.

## 엣지 케이스

- 회의 전체가 한 화자 → entry 1개(전체 텍스트 병합). 정상.
- 병합 대상 발화의 text에 앞뒤 공백이 있어도 join 후 이중 공백이 생길 수 있으나,
  worker가 단어를 공백 join으로 생성하므로 실질적으로 발생하지 않는다. trim 후 join한다.
- silence 발화가 사이에 있던 자리는 이미 필터로 제거됐으므로 그 간격을 넘어 병합된다
  (의도된 동작 — 시간 간격 무관 결정에 포함).

## 테스트

매퍼 유닛 테스트 (`toMeetingDetail`):

- 연속 같은 화자 ok 발화가 하나로 병합된다 — 텍스트 공백 join, `t`는 첫 발화 시각,
  `sources`에 구성 발화 id·t가 순서대로 보존, `id === sources[0].id`.
- 화자가 바뀌면 블록이 분리된다.
- transcribe_failed가 사이에 있으면 경계로 작동한다(`[ok A, failed A, ok A]` → 3 entry,
  failed entry는 sources 1개).
- 단독 발화는 sources 1개로 유지된다.
- silence 발화를 사이에 두고 떨어져 있던 같은 화자 발화가 병합된다.
- `tracks` 막대 수·`spokenMs`는 병합과 무관하게 발화 단위 그대로다.

페이지 테스트 (`meeting.test.tsx`):

- 연속 같은 화자 발화가 한 블록으로 렌더된다(스피커 칩 1개, 텍스트 이어짐).
- 블록 중간 발화 id로 검색 점프 시 해당 발화의 `startMs` 시점으로 seek되고 블록이
  하이라이트된다.
- **다른 회의**의 병합 블록 중간 발화 검색 결과 클릭 시(pendingSeek 경로), 대상
  회의 로딩 후 해당 source의 `startMs` 시점으로 seek된다.
