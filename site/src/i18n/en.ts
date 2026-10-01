export const en = {
  meta: {
    title: "Damwha — Private, speaker-attributed conversation search for Mac",
    description:
      "Record conversations, search who said what, and jump to that moment in the original audio. Transcription, speaker ID and summaries run entirely on your Mac.",
    ogImage: "/og-en.png",
    ogImageAlt: "Damwha — Wait, who said that?",
    ogLocale: "en_US",
    ogLocaleAlt: "ko_KR",
  },
  nav: { home: "Damwha home", langSwitch: "한국어", langSwitchLabel: "한국어로 보기", github: "GitHub" },
  hero: {
    eyebrow: "Free and open source · macOS",
    title: "Wait, who said that?",
    lede: "Record a conversation and Damwha keeps track of who said what, and when. Search for it and jump straight to that moment in the original audio.",
    download: "Download for Mac",
    downloadFallback: "Download from GitHub",
    demo: "Try the live demo",
    demoUrl: "https://damwha-demo.0kimjae.dev/?lang=en",
    demoNote: "Live demo: read-only, no sign-up · sample conversations are in Korean",
    requirements: "Apple Silicon (M1+) · macOS 15+",
    appSize: (size: string) => `${size} app`,
    modelsNote: "Plus 8–40 GB of models, downloaded on first use",
    imageAlt: "Damwha's transcript view: conversation list, speaker-colored transcript and insight panel",
  },
  problem: {
    title: "Conversations pile up. Finding what was said doesn't get easier.",
    body: "Memory fades, and finding one line in a long recording is hard. Damwha tells speakers apart by their voices, and once it knows someone, it recognizes them in every other conversation too. Every line is saved with its text, audio and the turns around it.",
  },
  jump: {
    title: "Utterance jump",
    lede: "Search every conversation, press Enter, and land on the exact second — the line highlighted, the audio cued up.",
    caption: "⌘K → search → Enter: the playhead and the timeline move to the moment it was said.",
    videoLabel: "Screen recording: searching and jumping to the moment in the original audio",
    videoLang: "ko",
  },
  features: {
    title: "What else it does",
    items: [
      {
        title: "Knows who is speaking",
        body: "Voiceprint-based speaker identification. Enroll a speaker once and they're recognized in every later conversation.",
        image: "speakers" as const,
        alt: "Speaker management with enrolled voiceprints",
      },
      {
        title: "⌘K search, everywhere",
        body: "Hybrid search — meaning and keywords — over every utterance and conversation, from any screen.",
        image: "search" as const,
        alt: "Command palette search results across two conversations",
      },
      {
        title: "Lenses: decisions, action items, promises",
        body: "A local LLM pulls them out of each conversation, each with a link back to the evidence. Edit freely — re-extraction keeps what you touched.",
        image: "lenses" as const,
        alt: "Decisions lens listing items across conversations",
      },
      {
        title: "Tuned to your Mac",
        body: "Damwha reads your chip and memory and recommends a preset. Summaries come in the transcript's language, Korean or English — a Korean meeting can be summarized in English.",
        image: "settings" as const,
        alt: "Processing settings recommending a preset for this Mac",
      },
    ],
  },
  privacy: {
    title: "Private by design",
    body: "No cloud ML. Transcription, speaker identification, search and summaries all run on your Mac, and voiceprints stay on disk. Models download once, the first time they're needed — your recordings never leave the machine.",
    pipelineLabel: "Processing pipeline",
    pipeline: ["Audio", "Normalize", "Voice activity", "Diarization", "Speaker ID", "Whisper", "Search index", "Lenses ∥ summary"],
  },
  requirements: {
    title: "Requirements",
    rows: [
      ["Mac", "Apple Silicon (M1 or later), macOS 15 or later"],
      ["Disk for models", "About 8 GB (Light) · 20 GB (Standard) · 40 GB (Quality), downloaded on first use"],
      ["Display language", "Korean and English. English UI is rolling out — some screens are still in Korean."],
      ["Conversation language", "Transcription: auto, Korean, English, Japanese, Chinese. Summaries: the transcript's language, Korean or English."],
    ],
  },
  consent: {
    title: "Before you record",
    body: "Damwha shows no recording notice. It stores a voiceprint for everyone in the conversation, not just you. Getting consent — and following the law where you are — is on whoever runs it.",
  },
  faq: {
    title: "Questions",
    items: [
      { q: "Is it free?", a: "Yes. Damwha is open source under the MIT license." },
      { q: "Do I need an internet connection?", a: "Only to download models the first time they're used and to check for updates. Recording, transcription and search work offline." },
      { q: "Does it run on Intel Macs or Windows?", a: "No. The ML pipeline runs on Apple's MLX, which needs Apple Silicon." },
      { q: "Is the app in English?", a: "English UI is rolling out. Settings and the app menu are translated, and the remaining screens follow in upcoming releases. Conversations in Korean, English, Japanese and Chinese can be transcribed, and summaries can be written in Korean or English." },
      { q: "Can it record live?", a: "Yes. Live recording shows a running transcript preview, and the full pipeline runs when you stop." },
      { q: "How do updates work?", a: "The app checks GitHub Releases and tells you when a new version is out. Download the new DMG and replace the app — your data stays." },
      { q: "Can I undo an update?", a: "Yes. Before a new version upgrades the database, Damwha keeps a snapshot, and the app menu can restore it." },
      { q: "Are the demo voices real people?", a: "No. The sample conversations are AI-generated (Google NotebookLM Audio Overviews), processed by the real pipeline." },
    ],
  },
  footer: {
    tagline: "Personal conversation memory for Mac.",
    source: "Source on GitHub",
    releases: "Release notes",
    demo: "Live demo",
    license: "MIT License",
  },
  notFound: { title: "Page not found", body: "This page doesn't exist.", home: "Go to the home page" },
};

export type Dictionary = typeof en;
