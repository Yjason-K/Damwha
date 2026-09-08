import * as React from "react";

/** 샘플 한 개의 최대 길이(초). 화자를 알아보기엔 충분하고, 목록에서 듣기엔 짧다. */
export const SAMPLE_MAX_SECONDS = 8;

/** 재생할 한 구간 — 오디오 URL과 초 단위 시작/끝. */
export type SamplePlay = { url: string; start: number; end: number };

/** 미디어 프래그먼트 — 브라우저가 start에서 시작해 end에서 스스로 멈춘다. */
export function sampleSrc({ url, start, end }: SamplePlay): string {
  return `${url}#t=${start},${end}`;
}

/**
 * 공용 <audio> 하나로 미리듣기를 돌린다. 한 번에 한 행만 재생되고, 메인
 * 플레이어와는 별개라 본 재생 위치를 건드리지 않는다.
 *
 * URL을 훅이 아니라 toggle 인자가 들고 오는 이유 — 화자 목록은 행마다 샘플이
 * 나온 회의가 달라서, 회의 하나에 고정된 훅으로는 다룰 수 없다.
 */
export function useSamplePlayer() {
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [playingId, setPlayingId] = React.useState<string | null>(null);
  /** 재생 중인 샘플의 시작점 — timeupdate에서 경과 시간을 계산할 기준. */
  const startRef = React.useRef(0);
  const [elapsed, setElapsed] = React.useState(0);

  const stop = React.useCallback(() => {
    audioRef.current?.pause();
    setPlayingId(null);
  }, []);

  const toggle = React.useCallback(
    (id: string, sample: SamplePlay) => {
      const a = audioRef.current;
      if (!a) return;
      if (playingId === id) {
        stop();
        return;
      }
      a.pause();
      a.setAttribute("src", sampleSrc(sample));
      startRef.current = sample.start;
      setElapsed(0);
      setPlayingId(id);
      void a.play().catch(() => setPlayingId(null));
    },
    [playingId, stop],
  );

  const element = (
    <audio
      ref={audioRef}
      preload="none"
      onTimeUpdate={(e) =>
        setElapsed(Math.max(0, e.currentTarget.currentTime - startRef.current))
      }
      onPause={() => setPlayingId(null)}
      onEnded={() => setPlayingId(null)}
    />
  );

  return { element, playingId, elapsed, toggle, stop };
}
