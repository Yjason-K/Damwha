import type { Dictionary } from "./en";

export const ko = {
  meta: {
    title: "담화 Damwha — 내 Mac에서 도는 화자별 대화 기록·검색",
    description:
      "대화를 녹음하면 누가·언제·무슨 말을 했는지 발화 단위로 정리하고, 어떤 줄이든 한 번에 원본 음성으로 이어 줘요. 전사·화자 식별·요약이 모두 내 Mac 안에서 돌아요.",
    ogImage: "/og-ko.png",
    ogImageAlt: "담화 — 그 말, 그 순간으로.",
    ogLocale: "ko_KR",
    ogLocaleAlt: "en_US",
  },
  nav: { home: "담화 홈", langSwitch: "English", langSwitchLabel: "View in English", github: "GitHub" },
  hero: {
    eyebrow: "무료 · 오픈소스 · macOS",
    title: "그 말, 그 순간으로.",
    lede: "담화는 대화를 녹음해 누가·언제·무슨 말을 했는지 발화 단위로 정리해요. 어떤 줄이든 한 번에 원본 음성으로 이어지고, 모든 처리는 내 Mac 안에서 끝나요.",
    download: "Mac용 다운로드",
    downloadFallback: "GitHub에서 받기",
    demo: "데모 써보기",
    demoUrl: "https://damwha-demo.0kimjae.dev/?lang=ko",
    demoNote: "데모: 읽기 전용 · 가입 없이 바로",
    requirements: "Apple Silicon(M1 이상) · macOS 15 이상",
    appSize: (size: string) => `앱 ${size}`,
    modelsNote: "모델 8–40 GB는 처음 쓸 때 따로 받아요",
    imageAlt: "담화의 전사 화면: 회의 목록, 화자별 색으로 나뉜 발화, 인사이트 패널",
  },
  problem: {
    title: "대화는 쌓이는데, 그때 한 말을 찾기는 여전히 어려워요.",
    body: "기억은 흐려지고 녹취록은 길어요. 대부분의 전사 도구는 매번 “화자 1”의 이름을 손으로 바꾸게 하죠. 담화는 발화 하나를 기본 단위로 삼아요 — 누가 말했는지, 언제인지, 원문과 음성, 앞뒤 맥락이 함께 묶여 있어요.",
  },
  jump: {
    title: "발화 점프",
    lede: "모든 대화를 검색하고 Enter를 누르면 그 초로 바로 가요. 발화는 강조되고 음성은 그 자리에서 재생을 기다려요.",
    caption: "⌘K → 검색 → Enter: 재생 헤드와 타임라인이 그 말을 한 순간으로 이동해요.",
    videoLabel: "화면 녹화: 검색해서 원본 음성의 그 순간으로 이동하는 모습",
    videoLang: "ko",
  },
  features: {
    title: "그 밖에 하는 일",
    items: [
      {
        title: "누가 말했는지 알아요",
        body: "목소리 기반 화자 식별. 한 번 등록한 화자는 이후 모든 대화에서 알아봐요.",
        image: "speakers",
        alt: "성문이 등록된 화자 관리 화면",
      },
      {
        title: "어디서든 ⌘K 검색",
        body: "뜻과 키워드를 함께 보는 하이브리드 검색으로, 어느 화면에서든 모든 발화와 대화를 찾아요.",
        image: "search",
        alt: "두 대화에 걸친 명령 팔레트 검색 결과",
      },
      {
        title: "렌즈: 결정·할 일·약속",
        body: "로컬 LLM이 대화마다 뽑아 주고, 항목마다 근거 발화로 가는 링크가 있어요. 마음껏 고쳐도 다시 뽑을 때 손댄 것은 그대로 남아요.",
        image: "lenses",
        alt: "여러 대화의 결정 사항을 모은 렌즈 화면",
      },
      {
        title: "내 Mac에 맞춰서",
        body: "칩과 메모리를 읽어 프리셋을 추천해요. 요약은 녹취 언어·한국어·영어 중에서 골라요 — 한국어 회의를 영어로 요약받을 수도 있어요.",
        image: "settings",
        alt: "이 Mac에 맞는 프리셋을 추천하는 처리 설정 화면",
      },
    ],
  },
  privacy: {
    title: "처음부터 내 Mac 안에서",
    body: "클라우드 ML이 없어요. 전사·화자 식별·검색·요약이 모두 내 Mac에서 돌고, 성문은 디스크에만 남아요. 모델은 처음 쓸 때 한 번 받고, 녹음은 이 Mac을 떠나지 않아요.",
    pipelineLabel: "처리 과정",
    pipeline: ["오디오", "정규화", "음성 구간", "화자 분리", "화자 식별", "Whisper 전사", "검색 색인", "렌즈 ∥ 요약"],
  },
  requirements: {
    title: "필요한 것",
    rows: [
      ["Mac", "Apple Silicon(M1 이상), macOS 15 이상"],
      ["모델 용량", "가볍게 약 8 GB · 표준 약 20 GB · 정확하게 약 40 GB, 처음 쓸 때 받아요"],
      ["Hugging Face 토큰", "화자 분리에만 필요해요. Hugging Face에서 모델 약관에 동의한 토큰을 앱 안에서 넣으면 되고, 없어도 앱은 열려요."],
      ["화면 언어", "한국어·영어. 영어 화면은 차례로 번역 중이에요."],
      ["대화 언어", "전사: 자동·한국어·영어·일본어·중국어. 요약: 녹취 언어·한국어·영어."],
    ],
  },
  consent: {
    title: "녹음하기 전에",
    body: "담화는 녹음 고지를 화면에 띄우지 않아요. 나뿐 아니라 대화에 참여한 모든 사람의 성문이 저장돼요. 동의를 받고 적용되는 법을 지키는 책임은 쓰는 사람에게 있어요.",
  },
  faq: {
    title: "자주 묻는 질문",
    items: [
      { q: "무료인가요?", a: "네. MIT 라이선스의 오픈소스예요." },
      { q: "인터넷이 필요한가요?", a: "모델을 처음 받을 때와 업데이트를 확인할 때만요. 녹음·전사·검색은 오프라인에서도 돼요." },
      { q: "Intel Mac이나 Windows에서도 되나요?", a: "아니요. 처리 파이프라인이 Apple Silicon 전용인 MLX 위에서 돌아요." },
      { q: "영어로도 쓸 수 있나요?", a: "화면은 영어로 차례로 번역 중이에요. 지금은 설정과 앱 메뉴가 번역돼 있고 나머지 화면은 다음 판부터 옮겨요. 한국어·영어·일본어·중국어 대화를 전사하고, 요약은 한국어나 영어로 받을 수 있어요." },
      { q: "실시간으로 녹음할 수 있나요?", a: "네. 녹음하는 동안 전사 미리보기가 흐르고, 멈추면 전체 처리가 돌아요." },
      { q: "업데이트는 어떻게 하나요?", a: "앱이 GitHub Releases를 확인해 새 버전을 알려 줘요. 새 DMG를 받아 앱을 바꾸면 되고, 데이터는 그대로예요." },
      { q: "업데이트를 되돌릴 수 있나요?", a: "네. 새 버전이 데이터베이스를 올리기 전에 스냅샷을 떠 두고, 앱 메뉴에서 되돌릴 수 있어요." },
      { q: "데모의 목소리는 실제 사람인가요?", a: "아니요. Google NotebookLM Audio Overview로 만든 AI 음성이고, 진짜 파이프라인으로 처리한 결과예요." },
    ],
  },
  footer: {
    tagline: "Mac을 위한 개인 대화 기억 장치.",
    source: "GitHub 소스",
    releases: "릴리스 노트",
    demo: "라이브 데모",
    license: "MIT 라이선스",
  },
  notFound: { title: "페이지를 찾을 수 없어요", body: "없는 페이지예요.", home: "처음으로" },
} satisfies Dictionary;
