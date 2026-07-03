import type { IconName } from "../ui/icons";

/**
 * Mock corpus for the /app meeting shell — mirrors the Damwha Design System
 * UI-kit corpus (`ui_kits/timbre_app/data.jsx`). m1 is the kit's sample
 * meeting verbatim; m2–m5 are filled in so browsing, lenses, and search are
 * demo-able (the kit's global-lens extras live on their owning meetings).
 * No backend calls yet — this file is the single source the shell reads.
 */

export type Speaker = { id: number; name: string; role: string; spk: number };

export type TrackSegment = { start: number; end: number; soft?: boolean };

export type SpeakerLane = {
  spk: number;
  name: string;
  dur: string;
  segments: TrackSegment[];
};

export type UtteranceEntry = {
  id: string;
  spk: number;
  t: string;
  text: string;
  quoted?: boolean;
};

export type LensKind = "action" | "topic" | "decision" | "promise";

export type LensSource = "ai" | "user" | "edited" | "hint";

export type LensEntry = {
  id: string;
  text: string;
  source: LensSource;
  who?: number;
  ev: string;
  due?: string;
};

export type TopicChip = { label: string; spk: number };

export type FileEntry = { name: string; size: string };

export type Meeting = {
  id: string;
  title: string;
  /** Sidebar sub-line override (e.g. "이수민 1:1" for the "1:1" title). */
  subOverride?: string;
  date: string; // YYYY-MM-DD
  dur: string; // M:SS or MM:SS
  timeRange: string;
  files: FileEntry[];
  aiCount: number;
  aiHeadline: string;
  aiDetail: string;
  attendees: number[];
  unverified?: number[];
  fav?: boolean;
  summary: string[];
  tracks: SpeakerLane[];
  utterances: UtteranceEntry[];
  topics: TopicChip[];
  lenses: Partial<Record<LensKind, LensEntry[]>>;
};

export type MeetingFilter = "all" | "mine" | "fav";

/** The current user is speaker 1 (김영재) — used by the "내 참여" filter. */
export const ME = 1;

export const SPEAKERS: Record<number, Speaker> = {
  1: { id: 1, name: "김영재", role: "PM", spk: 1 },
  2: { id: 2, name: "이수민", role: "Designer", spk: 2 },
  3: { id: 3, name: "박지원", role: "Eng", spk: 3 },
  4: { id: 4, name: "정민호", role: "Eng", spk: 4 },
  5: { id: 5, name: "한서연", role: "Eng", spk: 5 },
};

export const MEETING_ORDER = ["m1", "m2", "m3", "m4", "m5"] as const;

export const MEETINGS: Record<string, Meeting> = {
  m1: {
    id: "m1",
    title: "기획회의 — UI 개선안",
    date: "2026-06-21",
    dur: "42:00",
    timeRange: "2026-06-21 (화) 10:30 – 11:12",
    files: [
      { name: "회의녹음_0621.m4a", size: "38.2MB" },
      { name: "UI개선안_시안.fig", size: "4.1MB" },
      { name: "회의록_기획회의.pdf", size: "218KB" },
    ],
    aiCount: 5,
    aiHeadline: "검색 인덱싱 방식과 UI 개선 방향에 대해 합의했어요.",
    aiDetail: "핵심 결정 3개 · 할 일 2개 · 다음 단계 2개",
    attendees: [1, 2, 3, 4],
    unverified: [4],
    fav: true,
    summary: [
      "사이드바(브라우즈) 우선, 검색은 ⌘K로 상시 호출하는 홈 구조를 확정.",
      "검색 인덱싱을 이번 스프린트에서 먼저 붙이고, UI 개선안은 다음 스프린트로 이월.",
      "성문 데이터는 로컬 보관, 내보내기는 기본 비활성 + 확인 단계로 처리.",
    ],
    tracks: [
      {
        spk: 1,
        name: "김영재",
        dur: "12:30",
        segments: [
          { start: 0.01, end: 0.1 },
          { start: 0.18, end: 0.22 },
          { start: 0.32, end: 0.37 },
          { start: 0.55, end: 0.7 },
        ],
      },
      {
        spk: 2,
        name: "이수민",
        dur: "08:14",
        segments: [
          { start: 0.11, end: 0.17 },
          { start: 0.38, end: 0.52 },
          { start: 0.74, end: 0.83 },
        ],
      },
      {
        spk: 3,
        name: "박지원",
        dur: "05:02",
        segments: [
          { start: 0.23, end: 0.27 },
          { start: 0.62, end: 0.66 },
          { start: 0.9, end: 0.97 },
        ],
      },
      {
        spk: 4,
        name: "정민호",
        dur: "03:40",
        segments: [
          { start: 0.28, end: 0.31 },
          { start: 0.71, end: 0.73 },
          { start: 0.84, end: 0.88, soft: true },
        ],
      },
    ],
    utterances: [
      {
        id: "u1",
        spk: 1,
        t: "11:48",
        text: "오늘은 홈 구조부터 정하죠. 앱을 열면 뭘 먼저 보여줄지요.",
      },
      {
        id: "u2",
        spk: 2,
        t: "11:55",
        text: "저는 브라우즈 우선이 맞다고 봐요. 검색 우선은 코퍼스가 없을 때 빈 화면이 되니까요.",
      },
      {
        id: "u3",
        spk: 1,
        t: "12:04",
        text: "동의해요. 대신 검색은 어디서든 한 키로 부를 수 있어야 해요. ⌘K처럼요.",
      },
      {
        id: "u4",
        spk: 3,
        t: "12:11",
        text: "검색을 상시 기능으로 두면 인덱싱이 먼저 붙어야 합니다. 이번 스프린트에 넣죠.",
        quoted: true,
      },
      {
        id: "u5",
        spk: 2,
        t: "12:19",
        text: "그럼 UI 개선안은 다음 스프린트로 넘기는 게 좋겠네요. 사이드바 정리부터요.",
      },
      {
        id: "u6",
        spk: 4,
        t: "12:26",
        text: "인덱싱은 키워드랑 의미 임베딩 둘 다 태우는 걸로 할게요. 오늘 안에 초안 정리하겠습니다.",
      },
      {
        id: "u7",
        spk: 1,
        t: "12:38",
        text: "좋아요. 그리고 성문 데이터는 로컬에만 두는 전제 다시 확인하고요.",
      },
      {
        id: "u8",
        spk: 3,
        t: "12:47",
        text: "네, 내보내기는 기본으로 꺼두고 확인 단계를 넣는 걸로 합의했었죠.",
      },
      {
        id: "u9",
        spk: 2,
        t: "12:59",
        text: "맞아요. 그 경계만 지키면 됩니다.",
      },
      {
        id: "u10",
        spk: 1,
        t: "13:10",
        text: "정리하면 — 홈은 브라우즈 우선, 검색 상시, 인덱싱 이번 주, UI 다음 주.",
      },
    ],
    topics: [
      { label: "홈 구조", spk: 3 },
      { label: "검색 & 인덱싱", spk: 2 },
      { label: "보안", spk: 1 },
      { label: "UI 개선", spk: 5 },
    ],
    lenses: {
      action: [
        {
          id: "a1",
          text: "검색 인덱싱(키워드 + 의미 임베딩) 초안 정리",
          source: "ai",
          who: 4,
          ev: "12:26",
          due: "6/22",
        },
        {
          id: "a2",
          text: "UI 개선안 — 사이드바 정리부터 디자인 검토",
          source: "hint",
          who: 2,
          ev: "12:19",
          due: "6/28",
        },
      ],
      topic: [
        {
          id: "t1",
          text: "홈 구조 — 브라우즈 우선 vs 검색 우선",
          source: "ai",
          ev: "11:48",
        },
        { id: "t2", text: "검색 인덱싱", source: "ai", ev: "12:11" },
        { id: "t3", text: "성문 / 프라이버시", source: "ai", ev: "12:38" },
      ],
      decision: [
        {
          id: "d1",
          text: "홈은 브라우즈 우선, 검색 상시 제공",
          source: "ai",
          ev: "12:04",
        },
        {
          id: "d2",
          text: "검색 인덱싱 방식: 키워드 + 의미 임베딩",
          source: "ai",
          ev: "12:26",
        },
        {
          id: "d3",
          text: "데이터 보안: 로컬 보관, 내보내기 기본 비활성",
          source: "ai",
          ev: "12:47",
        },
      ],
      promise: [
        {
          id: "p1",
          text: "정민호 — 인덱싱 초안 오늘 안에 공유",
          source: "ai",
          who: 4,
          ev: "12:26",
        },
      ],
    },
  },

  m2: {
    id: "m2",
    title: "스프린트 회고",
    date: "2026-06-18",
    dur: "58:17",
    timeRange: "2026-06-18 (목) 14:00 – 14:58",
    files: [{ name: "회고보드_스냅샷.png", size: "1.8MB" }],
    aiCount: 4,
    aiHeadline: "지난 스프린트의 병목과 다음 개선 실험에 합의했어요.",
    aiDetail: "핵심 결정 1개 · 할 일 2개 · 개선 실험 2개",
    attendees: [1, 2, 3, 4, 5],
    summary: [
      "리뷰 사이클 단축(1일 내 머지)은 유지하고, STT 튜닝 작업은 산정에 버퍼를 둔다.",
      "성문 데이터 로컬 보관 원칙을 온보딩 문구와 문서로 명시한다.",
      "회의 그래프 기능은 초기 범위에서 제외하고 후순위 백로그로 이월.",
    ],
    tracks: [
      {
        spk: 1,
        name: "김영재",
        dur: "16:05",
        segments: [
          { start: 0.02, end: 0.08 },
          { start: 0.3, end: 0.38 },
          { start: 0.66, end: 0.78 },
          { start: 0.93, end: 0.98 },
        ],
      },
      {
        spk: 2,
        name: "이수민",
        dur: "09:40",
        segments: [
          { start: 0.35, end: 0.42 },
          { start: 0.52, end: 0.6 },
        ],
      },
      {
        spk: 3,
        name: "박지원",
        dur: "11:22",
        segments: [
          { start: 0.09, end: 0.18 },
          { start: 0.44, end: 0.5 },
        ],
      },
      {
        spk: 4,
        name: "정민호",
        dur: "08:51",
        segments: [
          { start: 0.19, end: 0.28 },
          { start: 0.8, end: 0.86, soft: true },
        ],
      },
      {
        spk: 5,
        name: "한서연",
        dur: "07:03",
        segments: [
          { start: 0.05, end: 0.09 },
          { start: 0.61, end: 0.65 },
        ],
      },
    ],
    utterances: [
      {
        id: "v1",
        spk: 1,
        t: "03:12",
        text: "지난 스프린트 돌아보죠. 좋았던 것부터요.",
      },
      {
        id: "v2",
        spk: 5,
        t: "04:05",
        text: "리뷰 사이클이 짧아진 게 컸어요. PR이 대부분 하루 안에 머지됐죠.",
      },
      {
        id: "v3",
        spk: 3,
        t: "06:40",
        text: "반대로 STT 파이프라인 튜닝에 시간이 생각보다 많이 갔습니다. 산정에 버퍼가 필요해요.",
      },
      {
        id: "v4",
        spk: 4,
        t: "12:00",
        text: "성문 등록 쪽 프라이버시 문의가 있었어요. 로컬 보관 원칙을 문서로 남기면 좋겠어요.",
      },
      {
        id: "v5",
        spk: 2,
        t: "21:15",
        text: "온보딩 화면의 성문 등록 안내 문구도 더 명확하게 바꿔볼게요.",
      },
      {
        id: "v6",
        spk: 1,
        t: "40:12",
        text: "회의 그래프는 초기 범위에서 빼고 후순위 백로그로 내리죠.",
        quoted: true,
      },
      {
        id: "v7",
        spk: 1,
        t: "55:30",
        text: "다음 스프린트는 검색 UI에 집중합시다. 오늘 나온 실험 두 개도 같이요.",
      },
    ],
    topics: [
      { label: "리뷰 사이클", spk: 5 },
      { label: "성문 / 프라이버시", spk: 4 },
      { label: "범위 조정", spk: 1 },
    ],
    lenses: {
      action: [
        {
          id: "g2",
          text: "회의 그래프는 초기 범위에서 제외 — 후순위 백로그로",
          source: "edited",
          who: 1,
          ev: "40:12",
          due: "6/25",
        },
        {
          id: "m2a2",
          text: "온보딩 성문 등록 안내 문구 개선",
          source: "ai",
          who: 2,
          ev: "21:15",
          due: "6/24",
        },
      ],
      topic: [
        { id: "gt2", text: "성문 / 프라이버시", source: "ai", ev: "12:00" },
        { id: "m2t2", text: "리뷰 사이클", source: "ai", ev: "04:05" },
      ],
      decision: [
        {
          id: "m2d1",
          text: "회의 그래프 기능은 백로그로 이월",
          source: "ai",
          ev: "40:12",
        },
      ],
      promise: [
        {
          id: "m2p1",
          text: "이수민 — 온보딩 문구 시안 이번 주 공유",
          source: "ai",
          who: 2,
          ev: "21:15",
        },
      ],
    },
  },

  m3: {
    id: "m3",
    title: "검색 인덱싱 설계",
    date: "2026-06-14",
    dur: "35:42",
    timeRange: "2026-06-14 (일) 15:00 – 15:36",
    files: [],
    aiCount: 3,
    aiHeadline: "하이브리드 인덱스 구조와 유사도 임계값을 정했어요.",
    aiDetail: "핵심 결정 2개 · 할 일 1개",
    attendees: [1, 3, 4],
    summary: [
      "키워드 역색인 + 의미 임베딩의 하이브리드 인덱스로 확정.",
      "화자 식별은 코사인 유사도 임계값 0.82로 우선 적용 후 조정.",
      "STT 후처리 정규화를 인덱싱 앞단에 먼저 붙인다.",
    ],
    tracks: [
      {
        spk: 1,
        name: "김영재",
        dur: "09:12",
        segments: [
          { start: 0.03, end: 0.12 },
          { start: 0.82, end: 0.94 },
        ],
      },
      {
        spk: 3,
        name: "박지원",
        dur: "13:30",
        segments: [
          { start: 0.28, end: 0.44 },
          { start: 0.56, end: 0.68 },
        ],
      },
      {
        spk: 4,
        name: "정민호",
        dur: "10:48",
        segments: [
          { start: 0.13, end: 0.26 },
          { start: 0.46, end: 0.54 },
        ],
      },
    ],
    utterances: [
      {
        id: "w1",
        spk: 1,
        t: "02:10",
        text: "검색 요구사항 정리부터요. 날짜·주제·참석자·내용을 조합하는 검색이 핵심이에요.",
      },
      {
        id: "w2",
        spk: 4,
        t: "05:10",
        text: "Whisper STT 품질이 인덱스 품질을 좌우해요. 후처리 정규화를 먼저 붙입시다.",
      },
      {
        id: "w3",
        spk: 3,
        t: "11:26",
        text: "키워드 역색인과 의미 임베딩을 같이 쓰는 하이브리드로 가는 게 좋겠어요.",
      },
      {
        id: "w4",
        spk: 4,
        t: "18:02",
        text: "좋아요, 하이브리드 인덱스로 확정합시다.",
        quoted: true,
      },
      {
        id: "w5",
        spk: 3,
        t: "21:30",
        text: "화자 식별은 코사인 유사도 임계값 0.82로 우선 적용해보고 조정하죠.",
      },
      {
        id: "w6",
        spk: 1,
        t: "30:05",
        text: "다음 회의 전까지 샘플 코퍼스로 검증 부탁해요.",
      },
    ],
    topics: [
      { label: "하이브리드 인덱스", spk: 3 },
      { label: "Whisper STT", spk: 4 },
      { label: "화자 식별", spk: 1 },
    ],
    lenses: {
      action: [
        {
          id: "g1",
          text: "코사인 유사도 임계값 0.82로 우선 적용해보기",
          source: "ai",
          who: 3,
          ev: "21:30",
          due: "6/17",
        },
      ],
      topic: [
        { id: "gt1", text: "Whisper STT 품질", source: "ai", ev: "05:10" },
        { id: "m3t2", text: "하이브리드 인덱스", source: "ai", ev: "11:26" },
      ],
      decision: [
        {
          id: "gd1",
          text: "키워드 + 의미 임베딩 하이브리드 인덱스로 확정",
          source: "ai",
          ev: "18:02",
        },
        {
          id: "m3d2",
          text: "STT 후처리 정규화 우선 적용",
          source: "ai",
          ev: "05:10",
        },
      ],
      promise: [
        {
          id: "m3p1",
          text: "박지원 — 샘플 코퍼스 검증 결과 공유",
          source: "ai",
          who: 3,
          ev: "30:05",
        },
      ],
    },
  },

  m4: {
    id: "m4",
    title: "1:1",
    subOverride: "이수민 1:1",
    date: "2026-06-20",
    dur: "22:18",
    timeRange: "2026-06-20 (토) 11:00 – 11:22",
    files: [],
    aiCount: 2,
    aiHeadline: "디자인 시스템 정리 방향과 다음 단계를 확인했어요.",
    aiDetail: "할 일 1개 · 약속 1개",
    attendees: [1, 2],
    fav: true,
    summary: [
      "디자인 토큰 정리는 완료, 컴포넌트 문서화가 다음 병목.",
      "화자 색이 텍스트로 쓰일 때의 대비비를 재검토하기로 함.",
    ],
    tracks: [
      {
        spk: 1,
        name: "김영재",
        dur: "08:20",
        segments: [
          { start: 0.02, end: 0.14 },
          { start: 0.6, end: 0.74 },
        ],
      },
      {
        spk: 2,
        name: "이수민",
        dur: "11:45",
        segments: [
          { start: 0.16, end: 0.42 },
          { start: 0.76, end: 0.9 },
        ],
      },
    ],
    utterances: [
      {
        id: "x1",
        spk: 1,
        t: "01:05",
        text: "요즘 디자인 시스템 정리는 어때요?",
      },
      {
        id: "x2",
        spk: 2,
        t: "03:30",
        text: "토큰은 정리됐는데, 컴포넌트 문서화가 밀려 있어요. 다음 1:1 전까지 초안을 잡아볼게요.",
      },
      {
        id: "x3",
        spk: 2,
        t: "08:40",
        text: "접근성 컬러 팔레트 대비비도 다시 봐야 해요. 화자 색이 텍스트로 쓰일 때요.",
      },
      {
        id: "x4",
        spk: 1,
        t: "15:20",
        text: "그건 다음 디자인 리뷰 안건으로 올리죠.",
      },
    ],
    topics: [
      { label: "디자인 시스템", spk: 2 },
      { label: "접근성", spk: 5 },
    ],
    lenses: {
      action: [
        {
          id: "g3",
          text: "접근성 컬러 팔레트 대비비 재검토",
          source: "user",
          who: 2,
          ev: "08:40",
          due: "6/26",
        },
      ],
      topic: [
        { id: "m4t1", text: "컴포넌트 문서화", source: "ai", ev: "03:30" },
      ],
      decision: [],
      promise: [
        {
          id: "m4p1",
          text: "이수민 — 컴포넌트 문서화 초안 다음 1:1 전까지",
          source: "ai",
          who: 2,
          ev: "03:30",
        },
      ],
    },
  },

  m5: {
    id: "m5",
    title: "디자인 리뷰",
    date: "2026-06-12",
    dur: "31:07",
    timeRange: "2026-06-12 (금) 16:00 – 16:31",
    files: [{ name: "디자인시안_v3.fig", size: "6.4MB" }],
    aiCount: 2,
    aiHeadline: "타임라인 플레이헤드와 발언 카드 스타일을 확정했어요.",
    aiDetail: "핵심 결정 2개",
    attendees: [3, 2, 4],
    summary: [
      "타임라인 플레이헤드는 트랙 전체를 가로지르는 단일 핀으로 확정.",
      "화자 색은 8색 팔레트 순환으로 유지.",
    ],
    tracks: [
      {
        spk: 2,
        name: "이수민",
        dur: "12:10",
        segments: [
          { start: 0.04, end: 0.2 },
          { start: 0.72, end: 0.88 },
        ],
      },
      {
        spk: 3,
        name: "박지원",
        dur: "09:35",
        segments: [
          { start: 0.22, end: 0.38 },
          { start: 0.56, end: 0.62 },
        ],
      },
      {
        spk: 4,
        name: "정민호",
        dur: "07:14",
        segments: [
          { start: 0.4, end: 0.54, soft: true },
          { start: 0.9, end: 0.96 },
        ],
      },
    ],
    utterances: [
      {
        id: "y1",
        spk: 2,
        t: "02:20",
        text: "타임라인 플레이헤드는 트랙 전체를 가로지르는 단일 핀으로 가죠.",
      },
      {
        id: "y2",
        spk: 3,
        t: "07:45",
        text: "발언 카드는 인용 상태일 때만 테두리를 강조하는 게 좋겠어요.",
      },
      {
        id: "y3",
        spk: 4,
        t: "14:10",
        text: "화자 색은 8색 팔레트 순환으로 충분해 보여요.",
      },
      {
        id: "y4",
        spk: 2,
        t: "25:00",
        text: "다음 리뷰에서 렌즈 뷰 시안을 봅시다.",
      },
    ],
    topics: [
      { label: "타임라인", spk: 1 },
      { label: "발언 카드", spk: 3 },
    ],
    lenses: {
      action: [],
      topic: [
        { id: "m5t1", text: "타임라인 플레이헤드", source: "ai", ev: "02:20" },
      ],
      decision: [
        {
          id: "m5d1",
          text: "플레이헤드는 단일 핀으로 확정",
          source: "ai",
          ev: "02:20",
        },
        {
          id: "m5d2",
          text: "화자 팔레트 8색 순환 유지",
          source: "ai",
          ev: "14:10",
        },
      ],
      promise: [],
    },
  },
};

export const LENS_META: Record<LensKind, { label: string; icon: IconName }> = {
  action: { label: "액션아이템", icon: "listChecks" },
  topic: { label: "주제·키워드", icon: "hash" },
  decision: { label: "결정사항", icon: "scale" },
  promise: { label: "약속·책임", icon: "handshake" },
};

export const LENS_KINDS = Object.keys(LENS_META) as LensKind[];

/** "MM/DD" for sidebar/lens meta lines. */
export function shortDate(date: string): string {
  return date.slice(5).replace("-", "/");
}

/** "M:SS" | "MM:SS" → seconds. */
export function durToSeconds(dur: string): number {
  const [m, s] = dur.split(":").map(Number);
  return m * 60 + (s || 0);
}

/** Sidebar sub-line: "김영재 외 3명 · 06/21" (or the meeting's override). */
export function meetingSub(m: Meeting): string {
  if (m.subOverride) return m.subOverride;
  const first = SPEAKERS[m.attendees[0]].name;
  const rest = m.attendees.length - 1;
  const who = rest > 0 ? `${first} 외 ${rest}명` : first;
  return `${who} · ${shortDate(m.date)}`;
}
