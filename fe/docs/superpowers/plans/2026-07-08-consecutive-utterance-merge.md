# 연속 같은 화자 발화 병합 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 트랜스크립트에서 연속된 같은 화자의 발화를 하나의 문단 블록으로 병합 표시하고, 발화 단위 추적성(검색 점프 정밀도)은 sources로 보존한다.

**Architecture:** FE 전용. `toMeetingDetail` 매퍼가 `visibleUtterances`를 순회하며 연속 같은 화자 ok 발화를 하나의 `UtteranceEntry`로 병합하고 구성 발화의 `{id, startMs}`를 `sources`에 보존한다. 소비처(`meeting.tsx`의 jumpTo/pendingSeek, `transcript-pane.tsx`의 active/스크롤)는 발화 id → 포함 블록 매핑으로 전환하고 seek은 `startMs` 기준(ms 정밀도)으로 바꾼다. tracks/발화시간은 병합 전 발화 단위 그대로.

**Tech Stack:** React 19 + Vite 8 + TypeScript strict, Vitest (jsdom) + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-08-consecutive-utterance-merge-design.md`

## Global Constraints

- 작업 디렉토리: `/Users/gim-yeongjae/project/daewha/fe` (모든 경로는 이 기준).
- Node 22 + pnpm 필수 — 명령마다 `nvm use 22 && pnpm ...`.
- TypeScript strict + `verbatimModuleSyntax` — 타입 임포트는 `import type`. `noUnusedLocals` 켜져 있음 — 변경으로 고아가 된 코드는 제거.
- 커밋 메시지 한국어(Conventional Commits 접두어 영문).
- 병합 규칙: 연속된 같은 화자(spk)의 `status === "ok"` 발화만 병합. 각 텍스트 trim 후 공백 한 칸 join. `transcribe_failed`는 병합 안 됨(단독 entry, 블록 경계). 시간 간격 무관.
- 불변식: `entry.id === entry.sources[0].id`, `entry.t === formatClock(entry.sources[0].startMs)`.
- seek은 반드시 `source.startMs` 기준(`startMs / 1000 / totalSeconds` 비율) — 표시 문자열 `t`(초 단위 floor)로 seek하지 말 것.
- "원문 보기" 버튼은 블록 시작으로 점프(의도된 UX) — 변경하지 말 것.
- tracks(타임라인 막대)·spokenMs는 병합 전 `visibleUtterances` 기준 유지 — 변경하지 말 것.
- `pnpm format`이 무관한 기존 파일을 리플로우하면 git-restore하고 in-scope 파일만 커밋(선행 작업에서 동일 상황 있었음).
- 마무리 전 `pnpm format` 실행.

---

### Task 1: 매퍼 — 연속 발화 병합 + sources

**Files:**
- Modify: `src/features/meeting/model/types.ts:31-40` (`UtteranceEntry`)
- Modify: `src/features/meeting/api/mappers.ts:136-143` (`utteranceEntries` 파생)
- Test: `src/features/meeting/api/mappers.test.ts`

**Interfaces:**
- Consumes: `visibleUtterances`(silence·빈 text 필터 완료, `mappers.ts:107`), `spkOf`, `formatClock` — 기존 그대로.
- Produces: `UtteranceSource = { id: string; startMs: number }`, `UtteranceEntry`에 `sources: UtteranceSource[]` 추가. Task 2의 jumpTo/pendingSeek/transcript-pane이 `entry.sources.some((s) => s.id === uid)` 매핑과 `source.startMs` seek에 의존한다.

- [ ] **Step 1: 기존 테스트 기대값에 sources 추가 (실패하는 상태로)**

`src/features/meeting/api/mappers.test.ts`의 `"발화를 order_index 순으로 정렬하고 id/시각/텍스트를 매핑한다"` 기대값 교체 (기존 fixture는 화자 순서 1→2→3→1이라 병합 없음 — sources만 추가):

```ts
  it("발화를 order_index 순으로 정렬하고 id/시각/텍스트를 매핑한다", () => {
    expect(detail.utterances).toEqual([
      {
        id: "utt_1",
        spk: 1,
        t: "00:00",
        text: "안녕하세요",
        status: "ok",
        sources: [{ id: "utt_1", startMs: 0 }],
      },
      {
        id: "utt_2",
        spk: 2,
        t: "01:00",
        text: "네 반갑습니다",
        status: "ok",
        sources: [{ id: "utt_2", startMs: 60_000 }],
      },
      {
        id: "utt_3",
        spk: 3,
        t: "02:00",
        text: "시작하죠",
        status: "ok",
        sources: [{ id: "utt_3", startMs: 120_000 }],
      },
      {
        id: "utt_4",
        spk: 1,
        t: "1:00:00",
        text: "정리합니다",
        status: "ok",
        sources: [{ id: "utt_4", startMs: 3_600_000 }],
      },
    ]);
  });
```

- [ ] **Step 2: 신규 테스트 4개 추가**

`describe("toMeetingDetail", ...)` 블록 안에 추가:

```ts
  it("연속된 같은 화자의 ok 발화를 하나로 병합한다", () => {
    const wire = makeDetail();
    wire.utterances = [
      makeUtt({
        id: "b1",
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
        id: "b2",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 60_000,
        end_ms: 120_000,
        text: "반갑습니다",
        order_index: 1,
      }),
      makeUtt({
        id: "b3",
        speaker_id: null,
        speaker_name: null,
        speaker_status: null,
        diar_label: "SPEAKER_01",
        start_ms: 120_000,
        end_ms: 180_000,
        text: "네",
        order_index: 2,
      }),
    ];
    const d = toMeetingDetail(wire);
    expect(d.utterances).toEqual([
      {
        id: "b1",
        spk: 1,
        t: "00:00",
        text: "안녕하세요 반갑습니다",
        status: "ok",
        sources: [
          { id: "b1", startMs: 0 },
          { id: "b2", startMs: 60_000 },
        ],
      },
      {
        id: "b3",
        spk: 2,
        t: "02:00",
        text: "네",
        status: "ok",
        sources: [{ id: "b3", startMs: 120_000 }],
      },
    ]);
  });

  it("transcribe_failed는 병합되지 않고 블록 경계로 작동한다", () => {
    const wire = makeDetail();
    wire.utterances = [
      makeUtt({
        id: "c1",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 0,
        end_ms: 10_000,
        text: "앞",
        order_index: 0,
      }),
      makeUtt({
        id: "c2",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 10_000,
        end_ms: 20_000,
        text: null,
        status: "transcribe_failed",
        order_index: 1,
      }),
      makeUtt({
        id: "c3",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 20_000,
        end_ms: 30_000,
        text: "뒤",
        order_index: 2,
      }),
    ];
    const d = toMeetingDetail(wire);
    expect(
      d.utterances.map((u) => ({ id: u.id, text: u.text, status: u.status })),
    ).toEqual([
      { id: "c1", text: "앞", status: "ok" },
      { id: "c2", text: "", status: "transcribe_failed" },
      { id: "c3", text: "뒤", status: "ok" },
    ]);
    expect(d.utterances[1].sources).toEqual([{ id: "c2", startMs: 10_000 }]);
  });

  it("silence를 사이에 두고 떨어진 같은 화자 발화도 병합된다", () => {
    const wire = makeDetail();
    wire.utterances = [
      makeUtt({
        id: "d1",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 0,
        end_ms: 10_000,
        text: "앞",
        order_index: 0,
      }),
      makeUtt({
        id: "d2",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 10_000,
        end_ms: 20_000,
        text: null,
        status: "silence",
        order_index: 1,
      }),
      makeUtt({
        id: "d3",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 20_000,
        end_ms: 30_000,
        text: "뒤",
        order_index: 2,
      }),
    ];
    const d = toMeetingDetail(wire);
    expect(d.utterances).toHaveLength(1);
    expect(d.utterances[0].text).toBe("앞 뒤");
    expect(d.utterances[0].sources.map((s) => s.id)).toEqual(["d1", "d3"]);
  });

  it("tracks 막대와 spokenMs는 병합과 무관하게 발화 단위 그대로다", () => {
    const wire = makeDetail();
    wire.utterances = [
      makeUtt({
        id: "b1",
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
        id: "b2",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 60_000,
        end_ms: 120_000,
        text: "반갑습니다",
        order_index: 1,
      }),
    ];
    const d = toMeetingDetail(wire);
    // 목록은 1개 블록으로 병합되지만 타임라인 막대는 발화 2개 그대로.
    expect(d.utterances).toHaveLength(1);
    const lane1 = d.tracks.find((l) => l.spk === 1)!;
    expect(lane1.segments).toHaveLength(2);
    expect(lane1.dur).toBe("02:00");
  });
```

- [ ] **Step 3: 테스트 실행 — 실패 확인**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/api/mappers.test.ts`
Expected: FAIL — 현재 구현에는 `sources` 필드가 없고 병합도 안 하므로 수정·신규 테스트 실패. (`sources` 프로퍼티 TS 에러가 먼저 나올 수 있음 — 정상, Step 4에서 해소.)

- [ ] **Step 4: 도메인 타입에 sources 추가**

`src/features/meeting/model/types.ts`의 `UtteranceEntry` 블록 교체:

```ts
/** 병합 블록을 구성하는 원본 발화 참조 — seek은 ms 정밀도의 startMs로 한다. */
export type UtteranceSource = { id: string; startMs: number };

/**
 * 발화 카드 — 연속된 같은 화자의 ok 발화가 하나의 블록으로 병합된 표시 단위.
 * `sources`는 구성 발화의 id·start_ms(병합 순서대로). 불변식:
 * `id === sources[0].id`, `t === formatClock(sources[0].startMs)`.
 * silence는 매퍼에서 걸러지므로 status는 ok/transcribe_failed만 오고,
 * transcribe_failed는 병합되지 않는다(sources 1개).
 */
export type UtteranceEntry = {
  id: string;
  spk: number;
  t: string;
  text: string;
  status: "ok" | "transcribe_failed";
  sources: UtteranceSource[];
  quoted?: boolean;
};
```

- [ ] **Step 5: 매퍼 병합 구현**

`src/features/meeting/api/mappers.ts`에서 기존 `utteranceEntries` 파생(`// 5.` 블록, 137-143행) 교체:

```ts
  // 5. utterances(발화 카드) — 연속된 같은 화자의 ok 발화를 한 블록으로 병합.
  //    transcribe_failed는 병합하지 않고 경계로 작동한다. sources가 구성 발화의
  //    id·start_ms를 보존해 발화 단위 점프(검색 히트)의 정밀도를 지킨다.
  const utteranceEntries: UtteranceEntry[] = [];
  for (const u of visibleUtterances) {
    const spk = spkOf.get(identityKey(u))!;
    const status = u.status === "transcribe_failed" ? "transcribe_failed" : "ok";
    const text = (u.text ?? "").trim();
    const last = utteranceEntries[utteranceEntries.length - 1];
    if (last && status === "ok" && last.status === "ok" && last.spk === spk) {
      last.text = `${last.text} ${text}`;
      last.sources.push({ id: u.id, startMs: u.start_ms });
      continue;
    }
    utteranceEntries.push({
      id: u.id,
      spk,
      t: formatClock(u.start_ms),
      text,
      status,
      sources: [{ id: u.id, startMs: u.start_ms }],
    });
  }
```

임포트에 `UtteranceSource`는 필요 없음(구조적 타이핑) — `UtteranceEntry` 임포트는 기존 그대로.

- [ ] **Step 6: 테스트 실행 — 통과 확인**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/api/mappers.test.ts`
Expected: PASS (전체)

- [ ] **Step 7: 전체 테스트 + 타입체크**

Run: `nvm use 22 && pnpm test && pnpm build`
Expected: `meeting.test.tsx`의 기존 fixture는 연속 같은 화자가 없어(u1 spk1 → u2 spk2 → u3 spk3 → u5 failed) 병합이 일어나지 않고, 페이지 코드는 아직 `sources`를 참조하지 않으므로 전체 PASS. `tsc -b` 에러 없음.

- [ ] **Step 8: 커밋**

```bash
git add src/features/meeting/model/types.ts src/features/meeting/api/mappers.ts src/features/meeting/api/mappers.test.ts
git commit -m "feat: 연속된 같은 화자 발화를 매퍼에서 병합

- 연속 같은 화자 ok 발화를 한 블록으로 병합(trim 후 공백 join)
- transcribe_failed는 병합 안 함(블록 경계)
- sources에 구성 발화 id·start_ms 보존 — 발화 단위 점프 정밀도 유지
- tracks/spokenMs는 병합 전 발화 단위 유지"
```

---

### Task 2: 소비처 — sources 기반 점프·하이라이트

**Files:**
- Modify: `src/pages/meeting.tsx:79-84` (`clockToSeconds` 제거), `:259-271` (`jumpTo`), `:487-501` (pendingSeek 적용부)
- Modify: `src/features/meeting/ui/transcript-pane.tsx:356-369` (스크롤 효과), `:461-479` (발화 매핑의 active 판정)
- Test: `src/pages/meeting.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `UtteranceEntry.sources: { id: string; startMs: number }[]` (불변식: `id === sources[0].id`).
- Produces: 없음 (말단 소비처).

- [ ] **Step 1: 실패하는 페이지 테스트 작성**

`src/pages/meeting.test.tsx` fixture 수정 — `m2Detail.utterances`에 v2와 연속인 같은 화자 발화 추가(v2 뒤):

```ts
      utt({
        id: "v3",
        meeting_id: "m2",
        speaker_id: "sp_5",
        speaker_name: "한서연",
        speaker_status: "ready",
        diar_label: "SPEAKER_01",
        start_ms: 12_000,
        end_ms: 20_000,
        order_index: 2,
        text: "다음 스프린트도 이어가죠",
      }),
```

`search` fixture의 `results` 배열에 두 번째 히트 추가(기존 u1 히트 뒤):

```ts
      {
        utteranceId: "v3",
        meetingId: "m2",
        meetingTitle: "스프린트 회고",
        recordedAt: "2026-06-18T14:00:00.000Z",
        speaker: { id: "sp_5", name: "한서연" },
        diarLabel: "SPEAKER_01",
        startMs: 12_000,
        endMs: 20_000,
        text: "다음 스프린트도 이어가죠",
        score: 0.8,
      },
```

테스트 2개 추가:

```tsx
test("연속된 같은 화자 발화는 한 블록으로 병합 렌더된다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("button", { name: /스프린트 회고/ }));
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });
  const log = screen.getByRole("log", { name: "회의 전사" });
  // v2+v3가 한 블록(id는 첫 발화 v2)으로 병합, v3 행은 따로 없다.
  const block = log.querySelector('[data-uid="v2"]');
  expect(block).toHaveTextContent(
    "리뷰 사이클이 짧아진 게 컸어요 다음 스프린트도 이어가죠",
  );
  expect(log.querySelector('[data-uid="v3"]')).toBeNull();
});

test("다른 회의의 병합 블록 중간 발화로 검색 점프하면 해당 시점으로 seek되고 블록이 하이라이트된다", async () => {
  const { container } = renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const option = await screen.findByRole("option", {
    name: /다음 스프린트도 이어가죠/,
  });
  fireEvent.click(option);
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });
  // cross-meeting pendingSeek: 오디오 메타데이터 로드 시점에 적용된다.
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);
  // v3.start_ms = 12_000 → 12초 지점 (jsdom은 duration NaN → totalSeconds 사용).
  expect(audio.currentTime).toBeCloseTo(12, 3);
  // 하이라이트는 v3를 포함하는 블록(v2)에 걸린다.
  const log = screen.getByRole("log", { name: "회의 전사" });
  expect(log.querySelector('[data-uid="v2"]')).toHaveClass(
    "bg-[var(--accent-1)]",
  );
});
```

주의: 팔레트 옵션의 접근성 이름이 텍스트와 다르면(`findByRole("option", ...)` 실패) `within(listbox).findByText(/다음 스프린트도/)`로 옵션을 찾아 클릭하는 방식으로 조정 가능 — 단언 내용은 유지할 것.

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `nvm use 22 && pnpm vitest run src/pages/meeting.test.tsx`
Expected: 신규 테스트 2개 FAIL — Task 1 병합으로 `[data-uid="v3"]` 없음/블록 병합은 이미 성립하지만, 첫 테스트의 `toHaveTextContent`는 PASS 가능성 있음(병합은 Task 1에서 완료). 둘째 테스트는 pendingSeek이 아직 `find(x => x.id === "v3")`(블록 id는 v2)라 매칭 실패 → `currentTime` 0으로 FAIL. 기존 테스트는 전부 PASS 유지. (첫 테스트가 이미 PASS면 그대로 두고 진행 — 회귀 방지용.)

- [ ] **Step 3: meeting.tsx — sources 기반 점프**

`src/pages/meeting.tsx`:

`jumpTo` 교체:

```ts
  const jumpTo = (mid: string, uid: string) => {
    openMeeting(mid);
    setActiveId(uid);
    if (meeting && meeting.id === mid) {
      const source = meeting.utterances
        .flatMap((x) => x.sources)
        .find((s) => s.id === uid);
      if (source && totalSeconds > 0) {
        seek(Math.min(1, source.startMs / 1000 / totalSeconds));
      }
    } else {
      // 다른 회의로의 점프: 대상 회의 오디오가 준비되면(onLoadedMetadata) 적용한다.
      setPendingSeek({ mid, uid });
    }
  };
```

`onLoadedMetadata`의 pendingSeek 적용부 교체(주변 조건문은 그대로):

```ts
              const source = meeting.utterances
                .flatMap((x) => x.sources)
                .find((s) => s.id === pendingSeek.uid);
              if (source) {
                const fraction = Math.min(1, source.startMs / 1000 / total);
                el.currentTime = fraction * total;
                setPos(fraction);
              }
              setPendingSeek(null);
```

`clockToSeconds`(79행 부근)는 위 두 곳이 유일한 사용처였으므로 제거(`noUnusedLocals`가 강제함). 제거 전 `grep -n clockToSeconds src/pages/meeting.tsx`로 다른 사용처 없음을 확인.

- [ ] **Step 4: transcript-pane — 블록 해석 active·스크롤**

`src/features/meeting/ui/transcript-pane.tsx`:

스크롤 효과 앞(pendingCount 파생 아래)에 블록 해석 추가:

```ts
  // activeId는 원본 발화 id일 수 있다(검색 히트가 병합 블록 중간을 가리킴).
  // 포함하는 블록의 id로 해석해 하이라이트·스크롤 대상을 정한다.
  const activeBlockId = activeId
    ? (meeting.utterances.find((u) =>
        u.sources.some((s) => s.id === activeId),
      )?.id ?? "")
    : "";
```

스크롤 효과의 querySelector와 deps 수정:

```ts
  React.useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-uid="${activeBlockId}"]`,
    );
    const prev = prevRef.current;
    prevRef.current = { mid: meeting.id, uid: activeId };
    if (!el) return;
    el.scrollIntoView?.({ block: "nearest" });
    if (prev && prev.mid === meeting.id && prev.uid !== activeId) {
      const t = window.setTimeout(() => el.focus({ preventScroll: true }), 0);
      return () => window.clearTimeout(t);
    }
  }, [activeId, activeBlockId, meeting.id]);
```

발화 매핑의 active 판정 교체:

```tsx
                active={activeBlockId === u.id}
```

(`data-uid={u.id}`와 "원문 보기" `onJump(u.id)`는 그대로 — 블록 id 기준, 의도된 UX.)

- [ ] **Step 5: 테스트 실행 — 통과 확인**

Run: `nvm use 22 && pnpm vitest run src/pages/meeting.test.tsx`
Expected: PASS (신규 2개 포함 전체)

- [ ] **Step 6: 전체 검증**

Run: `nvm use 22 && pnpm test && pnpm build && pnpm lint && pnpm format`
Expected: 테스트 전체 PASS, 타입·린트 에러 없음. format이 무관 파일을 리플로우하면 git-restore.

- [ ] **Step 7: 커밋**

```bash
git add src/pages/meeting.tsx src/features/meeting/ui/transcript-pane.tsx src/pages/meeting.test.tsx
git commit -m "feat: 병합 블록 기준 점프·하이라이트 전환

- jumpTo/pendingSeek을 sources 검색 + startMs(ms 정밀도) seek으로 변경
- transcript-pane active·스크롤을 발화 id → 포함 블록 해석으로 전환
- clockToSeconds 제거(사용처 소멸)"
```
