/** 설정 화면 (pages/settings.tsx와 features/settings). */
export const settings = {
  general: {
    title: "일반",
    description: "앱 전체에 적용되는 설정이에요.",
    displayLanguage: {
      label: "화면 언어",
      hint: "메뉴와 화면에 쓰는 언어예요.",
    },
  },
  processing: {
    summaryLanguage: {
      label: "요약 언어",
      hint: "이미 만든 요약은 바뀌지 않아요. 다음 처리나 '다시 만들기'부터 적용돼요.",
      options: {
        transcript: "녹취 언어 따름",
        ko: "한국어",
        en: "영어",
      },
    },
  },
};
