import * as fs from "fs";
import * as path from "path";
import { isUiLanguage, type UiLanguage } from "../i18n/locale";

/**
 * 화면 언어의 원본 (다국어 스펙 §4.1). 파일이 없으면 기기 언어를 따른다 — 첫 실행에 쓰지 않는다.
 * 사람이 설정에서 고를 때만 쓴다(language-bridge.ts).
 *
 * 읽기는 절대 던지지 않는다: 깨진 파일 때문에 앱이 뜨지 않으면 언어를 고칠 화면에도 못 간다.
 * 쓰기는 던진다 — 호출자가 화면을 이전 값으로 되돌린다. 쓰기는 token-store.ts처럼 임시 파일 + rename.
 */
export const UI_LANGUAGE_FILE = "ui-language.json";

export interface UiLanguageStore {
  read(): UiLanguage | null;
  write(lang: UiLanguage): void;
}

export function makeUiLanguageStore(userData: string): UiLanguageStore {
  const file = path.join(userData, UI_LANGUAGE_FILE);
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed === null || typeof parsed !== "object") return null;
        const lang = (parsed as { language?: unknown }).language;
        return isUiLanguage(lang) ? lang : null;
      } catch {
        return null;
      }
    },
    write(lang) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ language: lang }), { flag: "w" });
      try {
        fs.renameSync(tmp, file);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    },
  };
}
