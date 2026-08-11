/**
 * 회의 도메인 모델 타입 — FE 프리즈드 인터페이스.
 *
 * API 매핑 레이어(`../api/mappers.ts`)가 산출하고 UI(`../ui/**`, `pages/**`)가
 * 소비하는 도메인 형태의 단일 출처. 와이어(서버 JSON) 타입은 `../api/types.ts`에
 * 별도로 두고, 여기서는 매핑 이후의 UI 친화 형태만 정의한다.
 *
 * 이 파일은 W1–W4가 코드를 작성하는 고정 계약이다 — 시그니처를 바꾸지 말 것.
 */

import type { SummaryStatus } from "../api/types";

export type MeetingStatus = "uploaded" | "processing" | "done" | "failed";

/** 회의별 등장 화자. `spk`는 등장 순으로 부여된 틴트 번호(1..n). */
export type SpeakerRef = {
  id: string | null;
  name: string;
  role: string;
  spk: number;
};

/** 화자 타임라인 구간 — start/end는 회의 전체 길이 대비 0–1 비율. */
export type TrackSegment = { start: number; end: number; soft?: boolean };

export type SpeakerLane = {
  spk: number;
  name: string;
  dur: string;
  segments: TrackSegment[];
};

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

export type LensKind = "action" | "decision" | "promise";

export type LensSource = "ai" | "user" | "edited" | "hint";

export type LensEntry = {
  id: string;
  text: string;
  source: LensSource;
  who?: number;
  ev: string;
  due?: string;
};

/** 단락별 요약 1개 — `t`는 시작 시각 표기, `id`는 점프 대상 발화 id. */
export type SummarySegmentView = {
  id: string;
  startUtteranceId: string;
  t: string;
  title: string;
  bullets: string[];
};

export type FileEntry = { name: string; size: string };

export type MeetingFilter = "all" | "fav";

/** 진단 클러스터(diarization) 1개 — 화자 검증/병합(resolve) UI의 입력. */
export type ClusterInfo = {
  id: string;
  diarLabel: string;
  spk: number;
  resolvedSpeakerId: string | null;
  speakerName: string | null;
  speakerStatus: "pending" | "ready" | "provisional" | "failed" | null;
};

/** 목록(좌측 네비) 카드용 요약 — GET /meetings 응답(발화 없음)에서 매핑. */
export type MeetingSummary = {
  id: string;
  title: string;
  date: string;
  dur: string;
  timeRange: string;
  sub: string;
  fav: boolean;
  status: MeetingStatus;
};

/** 상세 화면용 회의 — GET /meetings/:id(발화 포함)에서 매핑. */
export type Meeting = {
  id: string;
  title: string;
  date: string;
  dur: string;
  timeRange: string;
  files: FileEntry[];
  aiCount: number;
  aiHeadline: string;
  aiDetail: string;
  attendees: number[];
  unverified?: number[];
  fav?: boolean;
  tracks: SpeakerLane[];
  utterances: UtteranceEntry[];
  topics: string[];
  segments: SummarySegmentView[];
  summaryStatus: SummaryStatus | null;
  status: MeetingStatus;
  audioUrl: string;
  totalSeconds: number;
  speakers: Record<number, SpeakerRef>;
  clusters: ClusterInfo[];
};
