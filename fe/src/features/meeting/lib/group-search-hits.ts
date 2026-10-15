import type { SearchHit } from "../api/search";

export type GroupedHit = SearchHit & {
  /** 같은 문장이 나온 다른 회의 수 — 같은 녹음을 여러 번 올린 경우 등. */
  alsoIn: number;
};

export type MeetingHitGroup = {
  meetingId: string;
  meetingTitle: string | null;
  hits: GroupedHit[];
};

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** 포함 관계로 같은 발언이라고 보는 최소 길이. "네" 같은 짧은 말은 더 긴 말에 들어있기 쉬워 제외한다. */
const MIN_OVERLAP = 12;

// 같은 녹음을 다시 올려도 전사가 발화를 조금 다르게 자른다 — 실측에서 mtg_41은 "…지쳐
// 있어요."로, mtg_25·26은 "…지쳐 있어요. 요점만"으로 끝났다. 그래서 완전 일치만이 아니라
// 한쪽이 다른 쪽을 통째로 포함하는 경우도 같은 발언으로 본다.
function sameUtterance(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_OVERLAP && long.includes(short);
}

/**
 * ⌘K 발언 결과를 회의별로 묶는다. 순서는 검색 순위를 따른다 — 회의는 처음 등장한
 * 순서, 회의 안의 발언도 순위 순서.
 *
 * 같은 문장(공백 정규화 후 일치하거나 한쪽이 다른 쪽을 포함)은 처음 나온 자리에만 남기고 나머지는 `alsoIn`으로
 * 센다. 내용이 같은 회의 3건이 있으면 "설득"이 같은 문장으로 세 번 나오던 것을
 * 한 번 + "다른 회의 2건에도"로 접는다. 접혀서 남은 발언이 없는 회의는 빠진다.
 */
export function groupSearchHits(
  hits: SearchHit[],
  { maxMeetings = 5, perMeeting = 3 } = {},
): MeetingHitGroup[] {
  const groups = new Map<string, MeetingHitGroup>();
  const firsts: { key: string; entry: GroupedHit }[] = [];
  const countedMeetings = new Map<GroupedHit, Set<string>>();

  for (const hit of hits) {
    const key = normalize(hit.text);
    const first = key
      ? firsts.find((f) => sameUtterance(f.key, key))?.entry
      : undefined;
    if (first) {
      const seen = countedMeetings.get(first)!;
      if (!seen.has(hit.meetingId)) {
        seen.add(hit.meetingId);
        first.alsoIn += 1;
      }
      continue;
    }
    let group = groups.get(hit.meetingId);
    if (!group) {
      if (groups.size >= maxMeetings) continue;
      group = {
        meetingId: hit.meetingId,
        meetingTitle: hit.meetingTitle,
        hits: [],
      };
      groups.set(hit.meetingId, group);
    }
    if (group.hits.length >= perMeeting) continue;
    const entry: GroupedHit = { ...hit, alsoIn: 0 };
    group.hits.push(entry);
    if (key) {
      firsts.push({ key, entry });
      countedMeetings.set(entry, new Set([hit.meetingId]));
    }
  }
  return [...groups.values()].filter((g) => g.hits.length > 0);
}
