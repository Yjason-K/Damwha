# 병합 블록 표시 상한 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 연속 발화 병합 블록에 400자 표시 상한을 두어, 한 화자의 긴 발화가 발화 경계에서 여러 블록으로 나뉘어 렌더되게 한다.

**Architecture:** `toMeetingDetail`(FE 매퍼)의 병합 루프에 조건 하나를 추가한다 — 현재 블록 텍스트가 `MERGE_MAX_CHARS`(400) 이상이면 이어붙이지 않고 새 entry를 시작. 새 entry는 기존 생성 경로를 그대로 타므로 불변식(`id === sources[0].id`, `t === formatClock(sources[0].startMs)`)이 자동 유지되고, 점프·하이라이트·검색·tracks·UI 컴포넌트는 일절 변경하지 않는다.

**Tech Stack:** TypeScript (strict), Vitest (jsdom). Node 22 + pnpm 필수 — 새 셸은 Node 20일 수 있으니 명령마다 `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null &&`를 앞에 붙인다.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-13-merge-block-display-cap-design.md`
- 상한 상수: `MERGE_MAX_CHARS = 400`, `mappers.ts` 내 명명 상수
- 분할은 발화(source) 경계에서만 — 발화 내부는 절대 쪼개지 않는다
- 기존 병합 규칙 불변: 연속 같은 화자 · `status === "ok"`만 병합 · `transcribe_failed`는 경계
- `mappers.ts`와 `mappers.test.ts` 외 파일 수정 금지
- 커밋 메시지·주석은 한국어, 마무리 전 `pnpm format`

---

### Task 1: 매퍼 병합 루프에 400자 표시 상한 추가

**Files:**
- Modify: `src/features/meeting/api/mappers.ts:136-159` (병합 루프)
- Test: `src/features/meeting/api/mappers.test.ts` (`toMeetingDetail` describe 블록 끝에 테스트 추가)

**Interfaces:**
- Consumes: `toMeetingDetail(wire: WireMeetingDetail): MeetingDetail` — 기존 시그니처 그대로.
- Produces: 동작 변경만. `MeetingDetail.utterances`의 병합 entry가 400자 상한으로 분할됨. 타입 변경 없음, export 추가 없음 (`MERGE_MAX_CHARS`는 모듈 내부 상수).

- [ ] **Step 1: 실패하는 테스트 작성**

`src/features/meeting/api/mappers.test.ts`의 `describe("toMeetingDetail", ...)` 블록 맨 끝(기존 `tracks 막대와 spokenMs는...` 테스트 뒤)에 추가:

```ts
  it("병합 블록이 400자 상한을 넘으면 발화 경계에서 분할된다", () => {
    const long = (ch: string) => ch.repeat(300);
    const wire = makeDetail();
    wire.utterances = [
      makeUtt({
        id: "e1",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 0,
        end_ms: 60_000,
        text: long("가"),
        order_index: 0,
      }),
      makeUtt({
        id: "e2",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 60_000,
        end_ms: 120_000,
        text: long("나"),
        order_index: 1,
      }),
      makeUtt({
        id: "e3",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 120_000,
        end_ms: 180_000,
        text: long("다"),
        order_index: 2,
      }),
    ];
    const d = toMeetingDetail(wire);
    // e1(300자)에 e2를 붙일 때는 상한(400) 미만이라 병합(601자),
    // e3을 붙일 때는 601 >= 400이라 새 블록.
    expect(d.utterances).toHaveLength(2);
    expect(d.utterances[0].text).toBe(`${long("가")} ${long("나")}`);
    expect(d.utterances[0].sources.map((s) => s.id)).toEqual(["e1", "e2"]);
    // 분할된 블록도 불변식을 지킨다: id는 첫 source, t는 첫 source의 시각.
    expect(d.utterances[1]).toEqual({
      id: "e3",
      spk: 1,
      t: "02:00",
      text: long("다"),
      status: "ok",
      sources: [{ id: "e3", startMs: 120_000 }],
    });
  });

  it("400자를 넘는 단일 발화는 쪼개지지 않고 한 블록으로 유지된다", () => {
    const wire = makeDetail();
    wire.utterances = [
      makeUtt({
        id: "f1",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 0,
        end_ms: 60_000,
        text: "가".repeat(500),
        order_index: 0,
      }),
      makeUtt({
        id: "f2",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 60_000,
        end_ms: 120_000,
        text: "뒤",
        order_index: 1,
      }),
    ];
    const d = toMeetingDetail(wire);
    // f1은 단독으로 이미 상한 초과 → f2는 병합되지 않고 새 블록.
    expect(d.utterances.map((u) => u.text)).toEqual(["가".repeat(500), "뒤"]);
    expect(d.utterances[0].sources).toEqual([{ id: "f1", startMs: 0 }]);
    expect(d.utterances[1].sources).toEqual([{ id: "f2", startMs: 60_000 }]);
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm vitest run src/features/meeting/api/mappers.test.ts`
Expected: 새 테스트 2건 FAIL (현재는 상한 없이 전부 병합되므로 `toHaveLength(2)`가 1을 받음), 기존 테스트는 PASS.

- [ ] **Step 3: 최소 구현**

`src/features/meeting/api/mappers.ts`의 병합 루프를 수정한다. 루프 위(주석 `// 5. utterances...` 앞)에 상수 추가:

```ts
// 병합 블록 표시 상한 — 이 길이를 넘으면 발화 경계에서 새 블록을 시작한다.
// 전폭 기준 약 3~4줄(문단 크기). 스펙:
// docs/superpowers/specs/2026-07-13-merge-block-display-cap-design.md
const MERGE_MAX_CHARS = 400;
```

병합 조건에 길이 검사 추가 — 기존:

```ts
    if (last && status === "ok" && last.status === "ok" && last.spk === spk) {
```

변경:

```ts
    if (
      last &&
      status === "ok" &&
      last.status === "ok" &&
      last.spk === spk &&
      last.text.length < MERGE_MAX_CHARS
    ) {
```

`MERGE_MAX_CHARS`는 함수 밖 모듈 스코프 상수로 둔다 (export 하지 않음).

- [ ] **Step 4: 테스트 통과 확인**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm vitest run src/features/meeting/api/mappers.test.ts`
Expected: 전부 PASS (기존 병합 테스트 포함 — 기존 픽스처 텍스트는 모두 400자 미만이라 동작 불변).

- [ ] **Step 5: 전체 검증**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm build && pnpm lint && pnpm test && pnpm format`
Expected: `tsc -b` 타입 에러 없음, eslint 경고 없음, 테스트 전체(40건) PASS, format이 파일을 바꾸면 그대로 포함.

- [ ] **Step 6: 커밋**

```bash
git add src/features/meeting/api/mappers.ts src/features/meeting/api/mappers.test.ts
git commit -m "feat: 병합 블록에 400자 표시 상한 — 발화 경계에서 분할"
```
