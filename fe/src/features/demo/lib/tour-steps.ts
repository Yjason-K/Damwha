import type { SimStage } from "../model/upload-simulation";
import { clickTour, setReactInputValue, sleep, tourSelector, waitFor } from "./wait-for";

export type TourStep = {
  id: string;
  /** data-tour 값. */
  target: string;
  title: string;
  description: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** 이 단계를 하이라이트하기 전에 화면을 준비한다(라우트 이동·모달 열기·탭 전환). */
  prepare?: () => Promise<void>;
  /** 시뮬레이션 진행을 description에 반영하고 done 전엔 "다음"을 막는다. */
  live?: boolean;
};

const NARRATION: Record<SimStage, string> = {
  queued: "워커가 작업을 집어 들길 기다리는 중이에요.",
  vad: "음성 구간 감지(VAD) — 침묵을 걷어내고 말이 있는 구간만 남겨요.",
  diarize: "화자 분리 — 목소리 특징으로 \"누가 언제 말했는지\" 구간을 나눠요.",
  identify: "화자 식별 — 나뉜 목소리를 등록된 성문(voiceprint)과 대조해요.",
  stt: "받아쓰기 — Whisper가 구간별로 텍스트를 만들어요.",
  align: "정렬 — 텍스트를 화자·시각에 맞춰 발화 단위로 붙여요.",
  persist: "저장 — 발화를 DB에 쓰고 원본 오디오와 연결해요.",
  embed: "색인 — 검색용 임베딩을 만들고, 이어서 렌즈 추출과 요약이 돌아요.",
};

export function stageNarration(stage: SimStage): string {
  return NARRATION[stage];
}

export const PROCESSING_FOOTNOTE =
  "실제로는 10분 회의에 몇 분이 걸리고, 이 처리는 Apple Silicon 로컬에서만 돌아요. 데모는 그 흐름을 12초로 재생해요.";

type Ctx = {
  navigate: (to: string) => void;
  searchQuery: string;
  hasUpload: boolean;
  /** 프로그램적 Escape 동안 러너의 종료 훅을 무시한다(tourRunner.withExitSuppressed). */
  suppressExit: <T>(fn: () => T) => T;
};

/** Escape를 document에 보내 Radix 다이얼로그를 닫는다. 러너가 이 동안 자기 종료 훅을 무시한다. */
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

export function buildTourSteps(ctx: Ctx): TourStep[] {
  const upload: TourStep[] = ctx.hasUpload
    ? [
        {
          id: "new",
          target: "new-meeting",
          title: "새 대화는 오디오에서 시작해요",
          description: "회의·인터뷰·통화 녹음을 올리면 화자 분리와 전사가 자동으로 돌아요.",
          side: "right",
        },
        {
          id: "upload",
          target: "upload-submit",
          title: "테스트 오디오로 올려볼게요",
          description:
            "데모는 파일을 받지 않아요. 미리 준비한 테스트 오디오가 놓여 있으니 그대로 업로드해요. 제목·녹음 일시·처리 설정은 실제 업로드와 같은 폼이에요.",
          side: "top",
          align: "end",
          prepare: async () => {
            clickTour("new-meeting");
            await waitFor(tourSelector("upload-submit"));
          },
        },
        {
          id: "processing",
          target: "processing-banner",
          title: "처리 중이에요",
          description: NARRATION.queued,
          side: "bottom",
          live: true,
          prepare: async () => {
            clickTour("upload-submit");
            await waitFor(tourSelector("processing-banner"), 5000);
          },
        },
      ]
    : [];

  return [
    {
      id: "list",
      target: "meeting-list",
      title: "처리된 대화가 여기 쌓여요",
      description: ctx.hasUpload
        ? "지금은 샘플 2건이에요. 각 대화는 화자별 발화·요약·렌즈까지 갖고 있어요."
        : "각 대화는 화자별 발화·요약·렌즈까지 갖고 있어요.",
      side: "right",
      prepare: async () => {
        ctx.navigate("/");
        await waitFor(tourSelector("meeting-list"));
      },
    },
    ...upload,
    {
      id: "utterance",
      target: "utterance",
      title: "발화 하나하나가 원본으로 이어져요",
      description:
        "발화는 화자·시각·원본 오디오를 갖고 있어요. \"원문 보기\"를 누르면 그 순간으로 재생이 점프해요 — 방금 눌러봤어요.",
      side: "right",
      prepare: async () => {
        const el = await waitFor(tourSelector("utterance"), 15_000);
        const jump = Array.from(el?.querySelectorAll("button") ?? []).find((b) =>
          b.textContent?.includes("원문 보기"),
        );
        jump?.click();
      },
    },
    {
      id: "player",
      target: "player-bar",
      title: "화자별 구간과 재생",
      description: "타임라인은 화자별로 색이 달라요. 배속을 바꾸거나 발화 단위로 앞뒤로 옮길 수 있어요.",
      side: "top",
    },
    {
      id: "summary",
      target: "insight-tab-summary",
      title: "요약",
      description: "참석자, 주요 주제, 단락별 요약이 자동으로 만들어져요. 요약 모델은 바꿔서 다시 만들 수 있어요.",
      side: "left",
      prepare: async () => {
        clickTour("insight-tab-summary");
        await sleep(150);
      },
    },
    {
      id: "lens",
      target: "lens-section",
      title: "렌즈 — 할 일·결정·약속",
      description: "대화에서 액션·결정·약속을 자동으로 뽑아요. 사람이 고치거나 지울 수 있고, 다시 뽑아도 손댄 항목은 남아요.",
      side: "left",
      prepare: async () => {
        document.querySelector(tourSelector("lens-section"))?.scrollIntoView({ block: "center" });
        await sleep(150);
      },
    },
    {
      id: "search",
      target: "search-palette",
      title: "모든 대화를 가로질러 검색",
      description: `⌘K로 어디서든 발화를 찾아요. "${ctx.searchQuery}"를 넣어봤어요 — 결과를 고르면 그 발화로 바로 점프해요.`,
      side: "bottom",
      prepare: async () => {
        clickTour("search-trigger");
        const input = await waitFor('[data-tour="search-palette"] input[role="combobox"]');
        if (input instanceof HTMLInputElement && ctx.searchQuery) {
          setReactInputValue(input, ctx.searchQuery);
          await sleep(400); // 250ms 디바운스 + 첫 결과
        }
      },
    },
    {
      id: "note",
      target: "insight-tab-note",
      title: "메모, 그리고 끝",
      description:
        "대화를 들으며 마크다운 메모를 남길 수 있어요. 여기까지가 둘러보기예요 — 이 데모는 읽기 전용이고, 오디오는 NotebookLM이 생성한 샘플이에요. 왼쪽 아래 \"둘러보기\"로 언제든 다시 볼 수 있어요.",
      side: "left",
      prepare: async () => {
        ctx.suppressExit(() => pressEscape());
        await sleep(200);
        clickTour("insight-tab-note");
        await sleep(150);
      },
    },
  ];
}
