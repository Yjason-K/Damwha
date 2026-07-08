import { describe, expect, it } from "vitest";
import { env } from "@/shared/config/env";
import {
  formatClock,
  meetingAudioUrl,
  toMeetingDetail,
  toMeetingSummary,
} from "./mappers";
import type { WireMeeting, WireMeetingDetail, WireUtterance } from "./types";

// 표시 문자열은 로컬 타임존으로 렌더하므로, 기대값도 동일한 Date API로 계산해
// 어떤 TZ에서도 테스트가 안정적이게 한다(하드코딩된 UTC 문자열 금지).
const WD = ["일", "월", "화", "수", "목", "금", "토"] as const;
const p2 = (n: number) => String(n).padStart(2, "0");
function expDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function expShort(iso: string): string {
  const d = new Date(iso);
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
}
function expTime(d: Date): string {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function expRange(iso: string, durationMs: number | null): string {
  const d = new Date(iso);
  const base = `${expDate(iso)} (${WD[d.getDay()]}) ${expTime(d)}`;
  return durationMs == null
    ? base
    : `${base} – ${expTime(new Date(d.getTime() + durationMs))}`;
}

function makeMeeting(overrides: Partial<WireMeeting> = {}): WireMeeting {
  return {
    id: "mtg_1",
    title: "기획회의",
    original_filename: "회의녹음.m4a",
    audio_key: "meetings/mtg_1/original.m4a",
    normalized_key: null,
    recorded_at: "2026-06-21T10:30:00.000Z",
    duration_ms: 3_720_000,
    status: "done",
    is_favorite: true,
    current_job_id: null,
    processing_version: 1,
    error: null,
    created_at: "2026-06-21T09:00:00.000Z",
    ...overrides,
  };
}

function makeUtt(overrides: Partial<WireUtterance> = {}): WireUtterance {
  return {
    id: "utt_0",
    meeting_id: "mtg_1",
    speaker_id: null,
    diar_label: "SPEAKER_00",
    start_ms: 0,
    end_ms: 0,
    text: "",
    confidence: null,
    status: "ok",
    transcript_error: null,
    order_index: 0,
    processing_version: 1,
    job_id: null,
    speaker_name: null,
    speaker_status: null,
    ...overrides,
  };
}

// 정렬 검증을 위해 order_index와 배열 순서를 어긋나게 넣는다.
function makeDetail(): WireMeetingDetail {
  return {
    ...makeMeeting(),
    utterances: [
      makeUtt({
        id: "utt_2",
        speaker_id: null,
        speaker_name: null,
        speaker_status: null,
        diar_label: "SPEAKER_01",
        start_ms: 60_000,
        end_ms: 120_000,
        text: "네 반갑습니다",
        order_index: 1,
      }),
      makeUtt({
        id: "utt_1",
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
        id: "utt_4",
        speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 3_600_000,
        end_ms: 3_720_000,
        text: "정리합니다",
        order_index: 3,
      }),
      makeUtt({
        id: "utt_3",
        speaker_id: "spk_2",
        speaker_name: "Speaker_001",
        speaker_status: "provisional",
        diar_label: "SPEAKER_02",
        start_ms: 120_000,
        end_ms: 180_000,
        text: "시작하죠",
        order_index: 2,
      }),
      makeUtt({
        id: "utt_5",
        speaker_id: null,
        speaker_name: null,
        speaker_status: null,
        diar_label: "SPEAKER_01",
        start_ms: 180_000,
        end_ms: 181_000,
        text: null,
        status: "silence",
        order_index: 4,
      }),
    ],
    clusters: [
      {
        id: "clu_1",
        diar_label: "SPEAKER_00",
        resolved_speaker_id: "spk_1",
        speaker_name: "김영재",
        speaker_status: "ready",
      },
      {
        id: "clu_2",
        diar_label: "SPEAKER_01",
        resolved_speaker_id: null,
        speaker_name: null,
        speaker_status: null,
      },
      {
        id: "clu_3",
        diar_label: "SPEAKER_02",
        resolved_speaker_id: "spk_2",
        speaker_name: "Speaker_001",
        speaker_status: "provisional",
      },
    ],
  };
}

describe("formatClock", () => {
  it("1시간 미만은 MM:SS로 포맷한다", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(59_000)).toBe("00:59");
    expect(formatClock(61_000)).toBe("01:01");
    expect(formatClock(3_599_000)).toBe("59:59");
  });

  it("1시간 이상은 H:MM:SS로 포맷한다", () => {
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_720_000)).toBe("1:02:00");
    expect(formatClock(3_661_000)).toBe("1:01:01");
  });
});

describe("meetingAudioUrl", () => {
  it("apiBaseUrl 기준 오디오 경로를 만든다", () => {
    expect(meetingAudioUrl("mtg_1")).toBe(
      `${env.apiBaseUrl}/meetings/mtg_1/audio`,
    );
  });
});

describe("toMeetingSummary", () => {
  it("회의 행을 목록 요약으로 매핑한다", () => {
    const recordedAt = "2026-06-21T10:30:00.000Z";
    const summary = toMeetingSummary(makeMeeting());
    expect(summary).toEqual({
      id: "mtg_1",
      title: "기획회의",
      date: expDate(recordedAt),
      dur: "1:02:00",
      timeRange: expRange(recordedAt, 3_720_000),
      sub: expShort(recordedAt),
      fav: true,
      status: "done",
    });
  });

  it("title이 null이면 대체 제목, recorded_at이 없으면 created_at을 쓴다", () => {
    const createdAt = "2026-07-03T09:00:00.000Z";
    const summary = toMeetingSummary(
      makeMeeting({
        title: null,
        recorded_at: null,
        duration_ms: null,
        is_favorite: false,
        status: "processing",
        created_at: createdAt,
      }),
    );
    expect(summary.title).toBe("제목 없는 회의");
    expect(summary.date).toBe(expDate(createdAt));
    expect(summary.dur).toBe("00:00");
    // duration이 없으면 종료 시각은 붙지 않는다.
    expect(summary.timeRange).toBe(expRange(createdAt, null));
    expect(summary.sub).toBe(expShort(createdAt));
    expect(summary.fav).toBe(false);
    expect(summary.status).toBe("processing");
  });
});

describe("toMeetingDetail", () => {
  const detail = toMeetingDetail(makeDetail());

  it("spk를 등장 순 distinct 화자 식별에 1..n으로 부여한다", () => {
    expect(detail.attendees).toEqual([1, 2, 3]);
    expect(detail.speakers).toEqual({
      1: { id: "spk_1", name: "김영재", role: "", spk: 1 },
      2: { id: null, name: "화자 2", role: "", spk: 2 },
      3: { id: "spk_2", name: "Speaker_001", role: "", spk: 3 },
    });
  });

  it("unverified는 미해결(speaker_id null) 또는 provisional 화자의 spk다", () => {
    expect(detail.unverified).toEqual([2, 3]);
  });

  it("발화를 order_index 순으로 정렬하고 id/시각/텍스트를 매핑한다", () => {
    expect(detail.utterances).toEqual([
      { id: "utt_1", spk: 1, t: "00:00", text: "안녕하세요", status: "ok" },
      { id: "utt_2", spk: 2, t: "01:00", text: "네 반갑습니다", status: "ok" },
      { id: "utt_3", spk: 3, t: "02:00", text: "시작하죠", status: "ok" },
      { id: "utt_4", spk: 1, t: "1:00:00", text: "정리합니다", status: "ok" },
    ]);
  });

  it("tracks는 화자별 구간을 duration_ms로 나눈 0–1 비율이다", () => {
    expect(detail.tracks).toHaveLength(3);
    const [lane1, lane2, lane3] = detail.tracks;

    expect(lane1.spk).toBe(1);
    expect(lane1.dur).toBe("03:00");
    expect(lane1.segments[0].start).toBeCloseTo(0, 5);
    expect(lane1.segments[0].end).toBeCloseTo(60_000 / 3_720_000, 5);
    expect(lane1.segments[1].start).toBeCloseTo(3_600_000 / 3_720_000, 5);
    expect(lane1.segments[1].end).toBeCloseTo(1, 5);

    expect(lane2.spk).toBe(2);
    expect(lane2.dur).toBe("01:00");
    expect(lane2.segments).toHaveLength(1);

    expect(lane3.spk).toBe(3);
    expect(lane3.dur).toBe("01:00");
  });

  it("duration_ms가 null이면 tracks는 빈 배열이다", () => {
    const noDuration = toMeetingDetail({
      ...makeDetail(),
      duration_ms: null,
    });
    expect(noDuration.tracks).toEqual([]);
    expect(noDuration.totalSeconds).toBe(0);
    expect(noDuration.dur).toBe("00:00");
  });

  it("clusters를 서버 clu_* id로 파생하고 diar_label 그룹의 spk를 붙인다", () => {
    expect(detail.clusters).toEqual([
      {
        id: "clu_1",
        diarLabel: "SPEAKER_00",
        spk: 1,
        resolvedSpeakerId: "spk_1",
        speakerName: "김영재",
        speakerStatus: "ready",
      },
      {
        id: "clu_2",
        diarLabel: "SPEAKER_01",
        spk: 2,
        resolvedSpeakerId: null,
        speakerName: null,
        speakerStatus: null,
      },
      {
        id: "clu_3",
        diarLabel: "SPEAKER_02",
        spk: 3,
        resolvedSpeakerId: "spk_2",
        speakerName: "Speaker_001",
        speakerStatus: "provisional",
      },
    ]);
  });

  it("발화가 없는 클러스터는 안정적 대체 spk를 받는다", () => {
    const wire = makeDetail();
    wire.clusters = [
      ...wire.clusters,
      {
        id: "clu_9",
        diar_label: "SPEAKER_09",
        resolved_speaker_id: null,
        speaker_name: null,
        speaker_status: null,
      },
    ];
    const withOrphan = toMeetingDetail(wire);
    const orphan = withOrphan.clusters.find((c) => c.id === "clu_9")!;
    expect(orphan.diarLabel).toBe("SPEAKER_09");
    // 발화에서 부여된 spk는 3개(1..3)이므로 대체 번호는 4.
    expect(orphan.spk).toBe(4);
    // 미해결이므로 unverified에도 포함된다.
    expect(withOrphan.unverified).toContain(4);
  });

  it("파생 불가 필드는 빈 기본값, 파일/오디오/상태는 그대로 매핑한다", () => {
    expect(detail.aiCount).toBe(0);
    expect(detail.aiHeadline).toBe("");
    expect(detail.summary).toEqual([]);
    expect(detail.topics).toEqual([]);
    expect(detail.lenses).toEqual({});
    expect(detail.files).toEqual([{ name: "회의녹음.m4a", size: "" }]);
    expect(detail.audioUrl).toBe(`${env.apiBaseUrl}/meetings/mtg_1/audio`);
    expect(detail.totalSeconds).toBe(3_720);
    expect(detail.status).toBe("done");
    expect(detail.fav).toBe(true);
  });

  it("original_filename이 없으면 files는 빈 배열이다", () => {
    const detailNoFile = toMeetingDetail({
      ...makeDetail(),
      original_filename: null,
    });
    expect(detailNoFile.files).toEqual([]);
  });

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
});
