# 빈 utterance 처리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회의 상세 화면에서 silence utterance를 숨기고 transcribe_failed utterance는 플레이스홀더로 표시한다.

**Architecture:** FE 전용 변경. `toMeetingDetail` 매퍼에서 전체 목록(`allUtterances` — 화자/참석자/클러스터 파생용)과 표시 목록(`visibleUtterances` — 트랜스크립트·타임라인용)을 분리하고, `UtteranceEntry`에 `status`를 보존해 렌더 레이어가 transcribe_failed를 플레이스홀더로 그린다. BE/worker/DB 변경 없음.

**Tech Stack:** React 19 + Vite 8 + TypeScript strict, Vitest (jsdom) + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-08-empty-utterance-handling-design.md`

## Global Constraints

- 작업 디렉토리: `/Users/gim-yeongjae/project/daewha/fe` (모든 경로는 이 기준 상대 경로).
- Node 22 + pnpm 필수. 셸 기본이 Node 20일 수 있으므로 명령마다 `nvm use 22 && pnpm ...` 형태로 실행.
- TypeScript strict + `verbatimModuleSyntax` — 타입 임포트는 `import type`.
- 커밋 메시지는 한국어(Conventional Commits 접두어는 영문 유지).
- 빈 text 판정 기준: `text == null || text.trim() === ""`.
- 플레이스홀더 문구(정확히 이 문자열): `전사하지 못한 구간입니다`
- 마무리 전 `pnpm format` 실행(Prettier: double quotes, trailing comma all).

**범위 제외 (스펙 결정 사항 — 구현하지 말 것):**

- 전체가 silence인 회의는 트랜스크립트 로그 영역이 빈 채로 남는다. 별도 빈 상태 UI를 추가하지 않는다(YAGNI, 스펙 결정).
- 검색(⌘K) 경로는 변경하지 않는다. BE 검색이 모든 경로에서 `u.status='ok' AND u.text IS NOT NULL`을 이미 필터한다(`be/src/search/search.repository.ts:57,104,124`) — 빈 히트는 발생하지 않는다.

---

### Task 1: 매퍼 — silence 필터링 + status 보존

**Files:**
- Modify: `src/features/meeting/model/types.ts:31-38` (`UtteranceEntry`)
- Modify: `src/features/meeting/api/mappers.ts:91-153` (`toMeetingDetail`)
- Test: `src/features/meeting/api/mappers.test.ts`

**Interfaces:**
- Consumes: `WireUtterance.status: "ok" | "silence" | "transcribe_failed"` (`src/features/meeting/api/types.ts:53`, 필수 필드 — undefined 방어 불필요).
- Produces: `UtteranceEntry.status: "ok" | "transcribe_failed"` — Task 2의 transcript-pane이 이 필드로 플레이스홀더를 분기한다. silence는 도메인 모델에 도달하지 않는다.

- [ ] **Step 1: 기존 테스트 기대값을 스펙에 맞게 수정 (실패하는 상태로)**

`src/features/meeting/api/mappers.test.ts`의 기존 fixture(`makeDetail`)에는 이미 silence 발화 `utt_5`(SPEAKER_01, 1초, text null)가 있다. 기존 기대값이 utt_5 노출을 전제하므로 수정한다.

`"발화를 order_index 순으로 정렬하고 id/시각/텍스트를 매핑한다"` 테스트의 기대값 교체:

```ts
  it("발화를 order_index 순으로 정렬하고 id/시각/텍스트를 매핑한다", () => {
    expect(detail.utterances).toEqual([
      { id: "utt_1", spk: 1, t: "00:00", text: "안녕하세요", status: "ok" },
      { id: "utt_2", spk: 2, t: "01:00", text: "네 반갑습니다", status: "ok" },
      { id: "utt_3", spk: 3, t: "02:00", text: "시작하죠", status: "ok" },
      { id: "utt_4", spk: 1, t: "1:00:00", text: "정리합니다", status: "ok" },
    ]);
  });
```

`"tracks는 화자별 구간을 duration_ms로 나눈 0–1 비율이다"` 테스트에서 lane2 기대값 수정 — silence utt_5(1초)가 빠지므로:

```ts
    expect(lane2.spk).toBe(2);
    expect(lane2.dur).toBe("01:00");
    expect(lane2.segments).toHaveLength(1);
```

- [ ] **Step 2: 신규 테스트 4개 추가**

`describe("toMeetingDetail", ...)` 블록 안에 추가:

```ts
  it("silence 발화는 utterances와 tracks에서 제거된다", () => {
    expect(detail.utterances.map((u) => u.id)).not.toContain("utt_5");
    // utt_5(SPEAKER_01, 1초)가 lane2의 막대·발화시간에 잡히지 않는다.
    const lane2 = detail.tracks.find((l) => l.spk === 2)!;
    expect(lane2.dur).toBe("01:00");
    expect(lane2.segments).toHaveLength(1);
  });

  it("transcribe_failed 발화는 status를 보존한 채 통과하고 타임라인에도 포함된다", () => {
    const wire = makeDetail();
    wire.utterances.push(
      makeUtt({
        id: "utt_6",
        speaker_id: "spk_2",
        speaker_name: "Speaker_001",
        speaker_status: "provisional",
        diar_label: "SPEAKER_02",
        start_ms: 200_000,
        end_ms: 210_000,
        text: null,
        status: "transcribe_failed",
        order_index: 5,
      }),
    );
    const d = toMeetingDetail(wire);
    const failed = d.utterances.find((u) => u.id === "utt_6")!;
    expect(failed.status).toBe("transcribe_failed");
    expect(failed.text).toBe("");
    // 실제 발화였으므로 타임라인 막대·발화시간에 포함된다.
    const lane3 = d.tracks.find((l) => l.spk === 3)!;
    expect(lane3.dur).toBe("01:10");
    expect(lane3.segments).toHaveLength(2);
  });

  it("ok인데 text가 빈(whitespace-only 포함) 발화는 제거된다", () => {
    const wire = makeDetail();
    wire.utterances.push(
      makeUtt({
        id: "utt_7",
        diar_label: "SPEAKER_01",
        start_ms: 190_000,
        end_ms: 195_000,
        text: "   ",
        status: "ok",
        order_index: 6,
      }),
    );
    const d = toMeetingDetail(wire);
    expect(d.utterances.map((u) => u.id)).not.toContain("utt_7");
  });

  it("발화가 전부 silence인 화자도 참석자와 타임라인 레인에 남는다", () => {
    const wire = makeDetail();
    wire.utterances = [
      makeUtt({
        id: "a1",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 0,
        end_ms: 60_000,
        text: "안녕하세요",
        order_index: 0,
      }),
      makeUtt({
        id: "a2",
        speaker_id: null,
        speaker_name: null,
        speaker_status: null,
        diar_label: "SPEAKER_01",
        start_ms: 60_000,
        end_ms: 70_000,
        text: null,
        status: "silence",
        order_index: 1,
      }),
    ];
    const d = toMeetingDetail(wire);
    // 화자 번호·참석자는 전체 발화(silence 포함) 기준으로 파생된다.
    expect(d.attendees).toEqual([1, 2]);
    expect(d.speakers[2].name).toBe("화자 2");
    // 레인은 남되 막대·발화시간은 0.
    const lane2 = d.tracks.find((l) => l.spk === 2)!;
    expect(lane2.dur).toBe("00:00");
    expect(lane2.segments).toEqual([]);
    // 트랜스크립트에는 나오지 않는다.
    expect(d.utterances.map((u) => u.id)).toEqual(["a1"]);
  });
```

- [ ] **Step 3: 테스트 실행 — 실패 확인**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/api/mappers.test.ts`
Expected: FAIL — 기존 구현은 utt_5를 포함하고 `status` 필드가 없으므로 수정한 기대값·신규 테스트 다수 실패. (`status` 프로퍼티 관련 TS 에러가 먼저 나올 수 있음 — 정상, Step 4에서 해소.)

- [ ] **Step 4: 도메인 타입에 status 추가**

`src/features/meeting/model/types.ts`의 `UtteranceEntry` 교체:

```ts
/**
 * 발화 카드 — `id`는 와이어 utterance id, `t`는 "MM:SS" 표시 문자열.
 * silence는 매퍼에서 걸러지므로 status는 ok/transcribe_failed만 온다.
 */
export type UtteranceEntry = {
  id: string;
  spk: number;
  t: string;
  text: string;
  status: "ok" | "transcribe_failed";
  quoted?: boolean;
};
```

- [ ] **Step 5: 매퍼 구현**

`src/features/meeting/api/mappers.ts`의 `toMeetingDetail` 수정.

함수 위에 헬퍼 추가(`identityKey` 아래):

```ts
/**
 * 트랜스크립트·타임라인에 표시할 발화인가 — silence 제외, ok인데 text가
 * 빈(whitespace-only 포함) 행도 제외. transcribe_failed는 플레이스홀더로
 * 표시하므로 통과시킨다. 화자/참석자/클러스터 파생은 전체 발화 기준.
 */
const isVisible = (u: WireUtterance) => {
  if (u.status === "silence") return false;
  if (u.status === "ok" && (u.text == null || u.text.trim() === ""))
    return false;
  return true;
};
```

`toMeetingDetail` 본문 변경 — 정렬 목록을 둘로 분리:

```ts
  const allUtterances = [...wire.utterances].sort(
    (a, b) => a.order_index - b.order_index,
  );
  const visibleUtterances = allUtterances.filter(isVisible);
```

- 기존 `utterances` 변수 참조 중 **화자 파생부는 `allUtterances`로**: 1(`spkOf` 루프), 2(`sampleBySpk` 루프), 7(clusters의 `spkByDiar` 루프).
- **표시 파생부는 `visibleUtterances`로**: 5(`utteranceEntries`), 6(tracks의 `own` 필터).

`utteranceEntries` 교체:

```ts
  // 5. utterances(발화 카드) — 표시 대상만. silence는 여기서 걸러진다.
  const utteranceEntries: UtteranceEntry[] = visibleUtterances.map((u) => ({
    id: u.id,
    spk: spkOf.get(identityKey(u))!,
    t: formatClock(u.start_ms),
    text: u.text ?? "",
    status: u.status === "transcribe_failed" ? "transcribe_failed" : "ok",
  }));
```

tracks의 `own` 필터 교체(나머지 로직 동일):

```ts
          const own = visibleUtterances.filter(
            (u) => spkOf.get(identityKey(u)) === spk,
          );
```

- [ ] **Step 6: 테스트 실행 — 통과 확인**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/api/mappers.test.ts`
Expected: PASS (전체)

- [ ] **Step 7: 전체 테스트 + 타입체크**

Run: `nvm use 22 && pnpm test && pnpm build`
Expected: 전체 테스트 PASS, `tsc -b` 에러 없음. (`pages/meeting.test.tsx`의 fixture는 전부 실제 text를 가진 ok 발화라 필터에 걸리지 않는다.)

- [ ] **Step 8: 커밋**

```bash
git add src/features/meeting/model/types.ts src/features/meeting/api/mappers.ts src/features/meeting/api/mappers.test.ts
git commit -m "feat: 매퍼에서 silence 발화 제거 및 status 보존

- allUtterances(화자·참석자·클러스터 파생) / visibleUtterances(트랜스크립트·타임라인) 분리
- silence와 빈 text(ok) 발화는 표시 목록에서 제외
- UtteranceEntry에 status(ok|transcribe_failed) 추가"
```

---

### Task 2: 렌더링 — transcribe_failed 플레이스홀더

**Files:**
- Modify: `src/shared/ui/utterance.tsx:81-175` (`UtteranceProps`, 비인용 분기)
- Modify: `src/features/meeting/ui/transcript-pane.tsx:461-475` (발화 매핑)
- Test: `src/pages/meeting.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `UtteranceEntry.status: "ok" | "transcribe_failed"`.
- Produces: `Utterance` 컴포넌트의 `placeholder?: boolean` prop — true면 본문 텍스트를 회색 이탤릭으로 렌더. 기존 소비처는 prop 미전달 시 동작 불변.

- [ ] **Step 1: 실패하는 페이지 테스트 작성**

`src/pages/meeting.test.tsx`의 `m1Detail.utterances` 배열 끝에 fixture 2개 추가(기존 u1–u3 뒤):

```ts
      utt({
        id: "u4",
        speaker_id: "sp_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 22_000,
        end_ms: 24_000,
        order_index: 3,
        text: null,
        status: "silence",
      }),
      utt({
        id: "u5",
        speaker_id: "sp_2",
        speaker_name: "이수민",
        speaker_status: "ready",
        diar_label: "SPEAKER_01",
        start_ms: 24_000,
        end_ms: 27_000,
        order_index: 4,
        text: null,
        status: "transcribe_failed",
      }),
```

테스트 추가(기존 `test("회의 셸은 전사·인사이트·플레이어를 렌더한다", ...)` 아래):

```tsx
test("silence 발화는 숨기고 transcribe_failed는 플레이스홀더로 렌더한다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  const log = screen.getByRole("log", { name: "회의 전사" });
  // silence 행은 렌더되지 않는다.
  expect(log.querySelector('[data-uid="u4"]')).toBeNull();
  // transcribe_failed 행은 플레이스홀더 문구와 함께 렌더된다.
  const failedRow = log.querySelector('[data-uid="u5"]');
  expect(failedRow).not.toBeNull();
  expect(failedRow).toHaveTextContent("전사하지 못한 구간입니다");
  // 플레이스홀더는 이탤릭(회색) 스타일로 구분된다.
  expect(failedRow!.querySelector("span.italic")).not.toBeNull();
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `nvm use 22 && pnpm vitest run src/pages/meeting.test.tsx`
Expected: 신규 테스트 FAIL — u4는 Task 1 필터로 이미 안 나오지만, u5가 플레이스홀더 문구 없이 빈 행으로 렌더되므로 `toHaveTextContent` 실패. 기존 테스트는 전부 PASS 유지.

- [ ] **Step 3: Utterance에 placeholder prop 추가**

`src/shared/ui/utterance.tsx`:

`UtteranceProps`에 필드 추가:

```ts
type UtteranceProps = Omit<React.ComponentProps<"div">, "children"> & {
  speaker?: number;
  name?: React.ReactNode;
  time?: React.ReactNode;
  active?: boolean;
  quoted?: boolean;
  placeholder?: boolean;
  badge?: React.ReactNode;
  onJump?: () => void;
  onBookmark?: () => void;
  children?: React.ReactNode;
};
```

함수 시그니처에 `placeholder = false` 추가:

```ts
function Utterance({
  className,
  speaker,
  name,
  time,
  active = false,
  quoted = false,
  placeholder = false,
  badge = "인용",
  onJump,
  onBookmark,
  children,
  ...rest
}: UtteranceProps) {
```

비인용 분기(하단 return)의 본문 span 교체:

```tsx
        <span
          className={cn(
            "text-read text-pretty",
            placeholder
              ? "italic text-[color:var(--text-muted)]"
              : "text-foreground",
          )}
        >
          {children}
        </span>
```

(인용(quoted) 분기는 저장 카드 전용이라 placeholder를 적용하지 않는다.)

- [ ] **Step 4: transcript-pane에서 분기**

`src/features/meeting/ui/transcript-pane.tsx`의 발화 매핑 교체:

```tsx
          {meeting.utterances.map((u) => {
            const failed = u.status === "transcribe_failed";
            return (
              <Utterance
                key={u.id}
                data-uid={u.id}
                tabIndex={-1}
                speaker={meeting.speakers[u.spk].spk}
                name={meeting.speakers[u.spk].name}
                time={u.t}
                active={activeId === u.id}
                quoted={u.quoted}
                placeholder={failed}
                onJump={() => onJump(u.id)}
              >
                {failed ? "전사하지 못한 구간입니다" : u.text}
              </Utterance>
            );
          })}
```

- [ ] **Step 5: 테스트 실행 — 통과 확인**

Run: `nvm use 22 && pnpm vitest run src/pages/meeting.test.tsx`
Expected: PASS (신규 포함 전체)

- [ ] **Step 6: 전체 검증**

Run: `nvm use 22 && pnpm test && pnpm build && pnpm lint && pnpm format`
Expected: 테스트 전체 PASS, 타입·린트 에러 없음, format이 수정한 파일 있으면 diff 확인 후 함께 커밋.

- [ ] **Step 7: 커밋**

```bash
git add src/shared/ui/utterance.tsx src/features/meeting/ui/transcript-pane.tsx src/pages/meeting.test.tsx
git commit -m "feat: transcribe_failed 발화를 플레이스홀더로 표시

- Utterance에 placeholder prop 추가(회색 이탤릭)
- transcript-pane에서 status 분기, 문구 '전사하지 못한 구간입니다'
- 원문 보기(오디오 점프) 버튼은 유지"
```
