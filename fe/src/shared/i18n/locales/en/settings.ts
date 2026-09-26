import type { LocaleShape } from "../../locale-shape";
import type { settings as ko } from "../ko/settings";

export const settings = {
  general: {
    title: "General",
    description: "Settings that apply to the whole app.",
    displayLanguage: {
      label: "Display language",
      hint: "The language used for menus and screens.",
    },
  },
  processing: {
    summaryLanguage: {
      label: "Summary language",
      hint: "Existing summaries stay as they are. The new language applies from the next processing run or when you regenerate.",
      options: {
        transcript: "Same as the recording",
        ko: "Korean",
        en: "English",
      },
    },
  },
} satisfies LocaleShape<typeof ko>;
