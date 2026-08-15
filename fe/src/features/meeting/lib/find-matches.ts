import type { UtteranceEntry } from "../model/types";

/**
 * 전사 내 찾기(Ctrl+F 계열)의 매칭 계산 — React 무관 순수 함수.
 *
 * 설계 전체가 "폴딩된 문자열의 인덱스 == 원문의 인덱스"라는 불변식 위에 선다.
 * 반환하는 start/end는 항상 **원문** `UtteranceEntry.text`의 인덱스다.
 */

/** 발화 내 매칭 한 건. start/end는 원문 text의 코드 유닛 인덱스. */
export type FindMatch = { uid: string; start: number; end: number };

/**
 * 인덱스 보존 케이스 폴딩 — 결과의 각 인덱스가 원문의 같은 인덱스에 대응한다.
 *
 * 문자열 전체에 `toLowerCase()`를 걸면 길이가 변할 수 있어(U+0130 "İ"는 1자가
 * 2자로) 오프셋이 밀린다. `toLocaleLowerCase()`는 여기에 더해 호스트 로케일까지
 * 탄다(터키 로케일에서 "I" → "ı"). 그래서 코드 포인트 단위로 접되 길이가
 * 변하는 문자는 접지 않는다 — 그런 문자는 대소문자 구분 없이 매칭되지 않지만,
 * 실패 모드가 "매칭 안 됨"이지 "엉뚱한 곳 강조"가 아니다.
 */
export function foldCase(s: string): string {
  let out = "";
  for (const ch of s) {
    // for...of는 코드 포인트 단위 순회라 서로게이트 페어가 쪼개지지 않는다.
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

/**
 * 화면에 보이는 순서(발화 순 → 발화 내 오프셋 순)로 매칭을 모은다.
 * 전사 실패 발화는 제외한다 — 화면에 그려지는 건 `text`가 아니라
 * "전사하지 못한 구간입니다"라는 UI 문구라, 포함시키면 카운트가 틀리고
 * 오프셋이 렌더되지 않는 텍스트를 가리킨다.
 */
export function findMatches(
  utterances: UtteranceEntry[],
  query: string,
): FindMatch[] {
  const needle = foldCase(query.trim());
  if (!needle) return [];

  const out: FindMatch[] = [];
  for (const u of utterances) {
    if (u.status === "transcribe_failed") continue;
    const hay = foldCase(u.text);
    let at = hay.indexOf(needle);
    while (at !== -1) {
      out.push({ uid: u.id, start: at, end: at + needle.length });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return out;
}
