/**
 * 데모 둘러보기의 브라우저 로컬 상태(투어 설계 §4.1). 서버는 읽기 전용이라 "테스트
 * 오디오를 올렸는가"는 이 브라우저에만 존재한다. 기존 damwha.demo-notice.v1 키는
 * 흡수한다 — 마이그레이션 없이 재방문자가 모달을 한 번 더 볼 뿐이다.
 */
export const TOUR_STORAGE_KEY = "damwha.demo-tour.v1";

export type TourState = {
  /** 테스트 오디오를 올려 투어 회의가 목록에 드러난 상태. */
  uploaded: boolean;
  /** 첫 방문 모달을 이미 봤다. */
  noticeSeen: boolean;
};

const DEFAULT: TourState = { uploaded: false, noticeSeen: false };

const listeners = new Set<(s: TourState) => void>();

export function readTourState(): TourState {
  try {
    const raw = localStorage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<TourState>;
    return {
      uploaded: parsed.uploaded === true,
      noticeSeen: parsed.noticeSeen === true,
    };
  } catch {
    return { ...DEFAULT }; // 사생활 모드 등 — 안내를 한 번 더 보이는 쪽이 안전
  }
}

export function writeTourState(patch: Partial<TourState>): void {
  const next = { ...readTourState(), ...patch };
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 저장 실패는 다음 방문에 다시 보이는 것뿐 */
  }
  for (const cb of listeners) cb(next);
}

export function subscribeTourState(cb: (s: TourState) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
