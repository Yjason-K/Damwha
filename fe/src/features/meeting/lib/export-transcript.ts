import type { Meeting } from "../model/types";

/**
 * 회의 전사 내보내기 — 도메인 `Meeting`을 텍스트 파일 본문으로 렌더한다.
 *
 * txt는 화면과 같은 병합 블록 단위(읽기용), srt는 병합 이전 원본 발화 단위
 * (자막용)로 쓴다. 병합 블록은 최대 400자까지 이어 붙기 때문에 수 분에 걸칠
 * 수 있고, 그대로 자막 큐로 만들면 한 줄이 화면에 몇 분씩 붙어 있게 된다.
 *
 * 순수 함수만 둔다 — Blob·다운로드 같은 브라우저 부수효과는 호출부(다이얼로그)
 * 몫이다.
 */

export type ExportFormat = "txt" | "srt";

/** txt는 두 토글 모두 쓰고, srt는 `speakers`만 쓴다(시각은 자막 규격상 필수). */
export type ExportOptions = { timestamps: boolean; speakers: boolean };

/** 내보내기가 실제로 읽는 회의의 부분집합. */
export type ExportSource = Pick<Meeting, "utterances" | "speakers">;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** ms → SRT 시각 "HH:MM:SS,mmm". 시 자리는 10시간을 넘어가면 자연히 늘어난다. */
function srtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const total = Math.floor(clamped / 1000);
  return (
    `${pad(Math.floor(total / 3600))}:` +
    `${pad(Math.floor((total % 3600) / 60))}:` +
    `${pad(total % 60)},${pad(clamped % 1000, 3)}`
  );
}

function speakerName(source: ExportSource, spk: number): string {
  return source.speakers[spk]?.name ?? `화자 ${spk}`;
}

function buildTxt(source: ExportSource, opts: ExportOptions): string {
  const blocks = source.utterances
    .filter((u) => u.text.trim() !== "")
    .map((u) => {
      const parts: string[] = [];
      if (opts.timestamps) parts.push(`[${u.t}]`);
      if (opts.speakers) parts.push(`${speakerName(source, u.spk)}:`);
      parts.push(u.text.trim());
      return parts.join(" ");
    });
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

function buildSrt(source: ExportSource, opts: ExportOptions): string {
  const cues = source.utterances
    .flatMap((u) => u.sources.map((s) => ({ ...s, spk: u.spk })))
    .filter((c) => c.text.trim() !== "")
    .map((c, i) => {
      // 길이가 0 이하인 큐는 플레이어가 통째로 건너뛴다 — 1ms는 주고 넘긴다.
      const end = Math.max(c.endMs, c.startMs + 1);
      const body = opts.speakers
        ? `${speakerName(source, c.spk)}: ${c.text.trim()}`
        : c.text.trim();
      return `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(end)}\n${body}`;
    });
  return cues.length === 0 ? "" : `${cues.join("\n\n")}\n`;
}

/** 회의 전사를 `format`에 맞는 파일 본문 문자열로 만든다. */
export function buildTranscriptExport(
  source: ExportSource,
  format: ExportFormat,
  opts: ExportOptions,
): string {
  return format === "srt" ? buildSrt(source, opts) : buildTxt(source, opts);
}

/** "제목_YYYY-MM-DD.확장자" — 파일명에 못 쓰는 문자는 밑줄로 바꾼다. */
export function exportFilename(
  meeting: Pick<Meeting, "title" | "date">,
  format: ExportFormat,
): string {
  const safe = meeting.title.replace(/[/\\:*?"<>|]/g, "_").trim() || "회의";
  return `${safe}_${meeting.date}.${format}`;
}
