import { useSyncExternalStore } from "react";

/**
 * 최근 본 회의 — 사이드바 `최근 본` 필터의 재료. 회의 화면이 상세를 받으면 그 id를 맨 앞에
 * 올린다(새 회의도 만든 직후 그 화면으로 가므로 바로 여기 오른다). 개인용 앱이라 기기별
 * localStorage로 충분하고, 서버에는 기록하지 않는다.
 *
 * 원본은 localStorage다. 스냅샷은 저장된 문자열이 바뀔 때만 다시 만들어 useSyncExternalStore가
 * 헛되이 다시 그리지 않게 한다. 저장소가 막힌 환경에서는 이번 세션 메모리로만 기억한다.
 */
export const RECENT_MEETINGS_KEY = "damwha:recent-meetings";
export const RECENT_MEETINGS_LIMIT = 15;

const listeners = new Set<() => void>();
let memory: string | null = null;
let cachedRaw: string | null | undefined;
let cachedIds: string[] = [];

function readRaw(): string | null {
  try {
    return localStorage.getItem(RECENT_MEETINGS_KEY);
  } catch {
    return memory;
  }
}

function parse(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === "string")
          .slice(0, RECENT_MEETINGS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function getSnapshot(): string[] {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedIds = parse(raw);
  }
  return cachedIds;
}

function write(ids: string[]) {
  const raw = JSON.stringify(ids);
  memory = raw;
  try {
    localStorage.setItem(RECENT_MEETINGS_KEY, raw);
  } catch {
    // 저장소를 쓸 수 없어도 이번 세션에는 memory로 기억한다.
  }
  listeners.forEach((l) => l());
}

export const recentMeetings = {
  getSnapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** 회의를 열었다 — 맨 앞으로 올린다. */
  visit(id: string) {
    const ids = getSnapshot();
    if (ids[0] === id) return;
    write([id, ...ids.filter((x) => x !== id)].slice(0, RECENT_MEETINGS_LIMIT));
  },
  /** 회의가 사라졌다(삭제·녹음 폐기). */
  remove(id: string) {
    const ids = getSnapshot();
    if (!ids.includes(id)) return;
    write(ids.filter((x) => x !== id));
  },
};

export function useRecentMeetingIds(): string[] {
  return useSyncExternalStore(recentMeetings.subscribe, getSnapshot);
}
