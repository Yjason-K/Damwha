import { common } from "./common";
import { settings } from "./settings";
import { share } from "./share";

/** 기준 사전. 네임스페이스 = 최상위 키. 새 네임스페이스는 여기와 en/index.ts, create-i18n.ts의 NAMESPACES에 함께 더한다. */
export const ko = { common, settings, share };
