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
} satisfies LocaleShape<typeof ko>;
