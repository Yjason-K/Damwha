/** 여러 화면이 함께 쓰는 문구. */
export const common = {
  test: {
    /** 인프라 테스트 전용 — 보간이 이스케이프되지 않는지 본다. */
    echo: "{{value}}",
  },
  /** 라우트 렌더 예외 화면(`app/route-error.tsx`). */
  routeError: {
    title: "화면을 그리지 못했어요",
    description:
      "예기치 못한 오류로 이 화면을 보여 줄 수 없어요. 다시 시도하거나 다른 화면으로 이동해 주세요.",
    retry: "다시 시도",
    reload: "새로고침",
    reloadBlocked:
      "녹음 중에 새로고침하면 녹음이 끊겨요. 먼저 녹음을 종료해 주세요.",
    recording: {
      title: "녹음은 계속되고 있어요",
      description:
        "이 화면에서 바로 녹음을 종료할 수 있어요. 지금까지 녹음된 내용은 남아 있어요.",
      stop: "녹음 종료",
      stopping: "종료 중…",
      stopFailed: "녹음을 종료하지 못했어요. 다시 눌러 주세요.",
      stopped: "녹음을 종료했어요. 마무리 처리는 회의 화면에서 이어져요.",
      discarded: "녹음된 내용이 없어 회의를 지웠어요.",
    },
  },
};
