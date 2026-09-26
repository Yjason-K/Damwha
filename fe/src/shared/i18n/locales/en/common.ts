import type { LocaleShape } from "../../locale-shape";
import type { common as ko } from "../ko/common";

export const common = {
  test: {
    echo: "{{value}}",
  },
} satisfies LocaleShape<typeof ko>;
