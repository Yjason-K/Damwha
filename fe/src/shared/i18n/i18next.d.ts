import "i18next";
import type { ko } from "./locales/ko";

// t("settings:general.title")의 키를 타입 검사한다. 기준은 ko — en은 satisfies로 같은 모양이 강제된다.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof ko;
  }
}
