import { env } from "@/shared/config/env";
import type { LensWireItem } from "@/features/lens/model/types";
import type {
  ClusterInfo,
  LensEntry,
  LensKind,
  Meeting,
  MeetingSummary,
  SpeakerLane,
  SpeakerRef,
  UtteranceEntry,
} from "../model/types";
import type { WireMeeting, WireMeetingDetail, WireUtterance } from "./types";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

// 병합 블록 표시 상한 — 이 길이를 넘으면 발화 경계에서 새 블록을 시작한다.
// 전폭 기준 약 3~4줄(문단 크기). 스펙:
// docs/superpowers/specs/2026-07-13-merge-block-display-cap-design.md
const MERGE_MAX_CHARS = 400;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** ms → "MM:SS" (1시간 미만) / "H:MM:SS" (1시간 이상). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** Date → "YYYY-MM-DD" (로컬 성분). */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Date → "MM/DD" (로컬 성분). */
function localShortDate(d: Date): string {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** Date → "HH:MM" (로컬 성분). */
function localTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * "2026-06-21 (일) 10:30 – 11:12" 형태의 표시용 구간 문자열.
 * 업로드가 로컬 시각을 UTC ISO로 보내므로, 표시도 대칭적으로 로컬 시각으로
 * 되돌린다(`new Date(iso)`로 파싱 후 로컬 성분 사용).
 */
function buildTimeRange(startIso: string, durationMs: number | null): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return startIso;
  const weekday = WEEKDAYS[start.getDay()];
  const base = `${localDate(start)} (${weekday}) ${localTime(start)}`;
  if (durationMs == null) return base;
  const end = new Date(start.getTime() + durationMs);
  return `${base} – ${localTime(end)}`;
}

/** 회의 오디오 스트리밍 URL. */
export function meetingAudioUrl(id: string): string {
  return `${env.apiBaseUrl}/meetings/${id}/audio`;
}

const titleOf = (title: string | null) => title ?? "제목 없는 회의";

const durOf = (durationMs: number | null) =>
  durationMs == null ? "00:00" : formatClock(durationMs);

/** GET /meetings 행 → 좌측 네비 요약 카드. */
export function toMeetingSummary(wire: WireMeeting): MeetingSummary {
  const startIso = wire.recorded_at ?? wire.created_at;
  const start = new Date(startIso);
  return {
    id: wire.id,
    title: titleOf(wire.title),
    date: localDate(start),
    dur: durOf(wire.duration_ms),
    timeRange: buildTimeRange(startIso, wire.duration_ms),
    sub: localShortDate(start),
    fav: wire.is_favorite,
    status: wire.status,
  };
}

/** 화자 식별 키: speaker_id 우선, 없으면 diar_label. */
const identityKey = (u: WireUtterance) => u.speaker_id ?? u.diar_label;

/**
 * 타임라인·발화시간에 넣을 발화인가 — silence 제외, ok인데 text가
 * 빈(whitespace-only 포함) 행도 제외. transcribe_failed는 실제 발화였으므로
 * 여기서는 통과시키고, 전사 카드에서만 뺀다(아래 5번). 화자/참석자/클러스터
 * 파생은 전체 발화 기준.
 */
const isVisible = (u: WireUtterance) => {
  if (u.status === "silence") return false;
  if (u.status === "ok" && (u.text == null || u.text.trim() === ""))
    return false;
  return true;
};

/**
 * GET /meetings/:id(발화 + 클러스터 포함) → 상세 화면용 회의.
 *
 * spk 틴트 번호는 발화 등장 순의 distinct 화자 식별(speaker_id, null이면
 * diar_label)에 1..n으로 부여한다. tracks/speakers는 발화에서 파생하고,
 * clusters/unverified는 서버가 준 meeting_cluster 행(diar_label 순)에서 파생한다.
 */
export function toMeetingDetail(wire: WireMeetingDetail): Meeting {
  const allUtterances = [...wire.utterances].sort(
    (a, b) => a.order_index - b.order_index,
  );
  const visibleUtterances = allUtterances.filter(isVisible);

  // 1. 식별 키 → spk 번호 (등장 순).
  const spkOf = new Map<string, number>();
  for (const u of allUtterances) {
    const key = identityKey(u);
    if (!spkOf.has(key)) spkOf.set(key, spkOf.size + 1);
  }

  // 2. spk → 대표 발화(화자 메타 조회용).
  const sampleBySpk = new Map<number, WireUtterance>();
  for (const u of allUtterances) {
    const spk = spkOf.get(identityKey(u))!;
    if (!sampleBySpk.has(spk)) sampleBySpk.set(spk, u);
  }

  // 3. speakers 레코드.
  const speakers: Record<number, SpeakerRef> = {};
  for (const [spk, u] of sampleBySpk) {
    speakers[spk] = {
      id: u.speaker_id,
      name: u.speaker_name ?? `화자 ${spk}`,
      role: "",
      spk,
    };
  }

  const attendees = [...sampleBySpk.keys()].sort((a, b) => a - b);

  // 5. utterances(발화 카드) — 연속된 같은 화자의 ok 발화를 한 블록으로 병합.
  //    transcribe_failed는 카드로 그리지 않는다(안내 문구가 전사 흐름을 끊는다).
  //    silence처럼 건너뛰므로 양옆 같은 화자 발화는 병합된다. sources가 구성
  //    발화의 id·start_ms를 보존해 발화 단위 점프(검색 히트)의 정밀도를 지키고,
  //    end_ms·text까지 함께 남겨 srt 내보내기가 병합 이전 경계를 되찾게 한다.
  const utteranceEntries: UtteranceEntry[] = [];
  for (const u of visibleUtterances) {
    if (u.status === "transcribe_failed") continue;
    const spk = spkOf.get(identityKey(u))!;
    const text = (u.text ?? "").trim();
    const last = utteranceEntries[utteranceEntries.length - 1];
    if (last && last.spk === spk && last.text.length < MERGE_MAX_CHARS) {
      last.text = `${last.text} ${text}`;
      last.sources.push({
        id: u.id,
        startMs: u.start_ms,
        endMs: u.end_ms,
        text,
      });
      continue;
    }
    utteranceEntries.push({
      id: u.id,
      spk,
      t: formatClock(u.start_ms),
      text,
      status: "ok",
      sources: [{ id: u.id, startMs: u.start_ms, endMs: u.end_ms, text }],
    });
  }

  // 6. tracks — 화자별 발화 구간을 duration_ms로 나눈 0–1 비율.
  const duration = wire.duration_ms;
  const tracks: SpeakerLane[] =
    duration == null || duration <= 0
      ? []
      : attendees.map((spk) => {
          const own = visibleUtterances.filter(
            (u) => spkOf.get(identityKey(u)) === spk,
          );
          const spokenMs = own.reduce(
            (sum, u) => sum + (u.end_ms - u.start_ms),
            0,
          );
          return {
            spk,
            name: speakers[spk].name,
            dur: formatClock(spokenMs),
            segments: own.map((u) => ({
              start: u.start_ms / duration,
              end: u.end_ms / duration,
            })),
          };
        });

  // 7. clusters — 서버가 준 meeting_cluster 행(diar_label 순). resolve는 실제
  //    clu_<n> PK(c.id)로 호출해야 한다. spk 틴트는 해당 diar_label 발화 그룹의
  //    번호를 쓰고, 발화가 없는 클러스터는 등장 순으로 이어지는 안정적 대체
  //    번호를 부여한다.
  const spkByDiar = new Map<string, number>();
  for (const u of allUtterances) {
    if (!spkByDiar.has(u.diar_label)) {
      spkByDiar.set(u.diar_label, spkOf.get(identityKey(u))!);
    }
  }
  let fallbackSpk = spkOf.size;
  const clusters: ClusterInfo[] = wire.clusters.map((c) => {
    let spk = spkByDiar.get(c.diar_label);
    if (spk == null) {
      fallbackSpk += 1;
      spk = fallbackSpk;
    }
    return {
      id: c.id,
      diarLabel: c.diar_label,
      spk,
      resolvedSpeakerId: c.resolved_speaker_id,
      speakerName: c.speaker_name,
      speakerStatus: c.speaker_status,
      suggestedSpeakerId: c.suggested_speaker_id ?? null,
      suggestedSpeakerName: c.suggested_speaker_name ?? null,
      suggestedSimilarity: c.suggested_similarity ?? null,
    };
  });

  // 8. unverified — 미해결(resolved_speaker_id null) 또는 provisional 클러스터의
  //    spk. insight-pane이 참석자(spk) 매칭에 쓴다.
  const unverified = clusters
    .filter(
      (c) => c.resolvedSpeakerId == null || c.speakerStatus === "provisional",
    )
    .map((c) => c.spk);

  const startIso = wire.recorded_at ?? wire.created_at;
  const start = new Date(startIso);

  return {
    id: wire.id,
    title: titleOf(wire.title),
    date: localDate(start),
    dur: durOf(duration),
    timeRange: buildTimeRange(startIso, duration),
    files: wire.original_filename
      ? [{ name: wire.original_filename, size: "" }]
      : [],
    aiCount: 0,
    aiHeadline: "",
    aiDetail: "",
    attendees,
    unverified,
    fav: wire.is_favorite,
    tracks,
    utterances: utteranceEntries,
    topics: wire.summary?.topics ?? [],
    segments: (wire.summary?.segments ?? []).map((s) => ({
      id: s.start_utterance_id,
      startUtteranceId: s.start_utterance_id,
      t: formatClock(s.start_ms),
      title: s.title,
      bullets: s.bullets,
    })),
    summaryStatus: wire.summary?.status ?? null,
    summaryError: wire.summary?.error ?? null,
    status: wire.status,
    recordedAtIso: wire.recorded_at ?? wire.created_at,
    error: wire.error ?? null,
    audioUrl: meetingAudioUrl(wire.id),
    totalSeconds: duration == null ? 0 : Math.floor(duration / 1000),
    speakers,
    clusters,
  };
}

/**
 * 회의별 렌즈 항목(GET /meetings/:id/lenses)을 인사이트 패널이 쓰는 형태로 바꾼다.
 * 담당 화자는 서버가 speaker id로 주고 UI는 틴트 번호(spk)를 쓰므로 여기서 역인덱싱한다.
 * 근거가 사라진 AI 항목은 전역 대시보드와 같은 규칙으로 "확인 필요"(hint)로 낮춘다.
 */
export function mapMeetingLenses(
  items: LensWireItem[],
  speakers: Record<number, SpeakerRef>,
): Partial<Record<LensKind, LensEntry[]>> {
  const spkBySpeakerId = new Map<string, number>();
  for (const ref of Object.values(speakers)) {
    if (ref.id) spkBySpeakerId.set(ref.id, ref.spk);
  }

  const grouped: Partial<Record<LensKind, LensEntry[]>> = {};
  for (const item of items) {
    const primary = item.evidence.find((e) => e.relation === "primary") ?? null;
    const who = item.assignee_speaker_id
      ? spkBySpeakerId.get(item.assignee_speaker_id)
      : undefined;
    const entry: LensEntry = {
      id: item.id,
      text: item.text,
      source: item.source === "ai" && !primary ? "hint" : item.source,
      who,
      ev: primary?.utterance.id ?? "",
      due: item.due_at ?? undefined,
      done: item.completion_status === "done",
    };
    (grouped[item.kind] ??= []).push(entry);
  }
  return grouped;
}
