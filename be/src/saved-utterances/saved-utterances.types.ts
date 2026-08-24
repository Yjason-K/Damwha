export type SavedUtteranceRow = {
  id: string;
  utterance_id: string | null;
  text: string;
  // 살아 있는 발화의 화자. 발화가 사라지면 null이라 이름 스냅샷만 남는다.
  speaker_id: string | null;
  speaker_name: string | null;
  start_ms: number;
  created_at: Date;
  meeting_id: string;
  meeting_title: string | null;
  recorded_at: Date | null;
  // date_trunc('milliseconds', COALESCE(recorded_at, meeting.created_at)) — the
  // meeting's sort key. recorded_at is nullable, so the fallback keeps the
  // keyset tuple free of NULLs.
  meeting_sort_at: Date;
};

// The list is grouped by meeting, so the cursor tuple leads with the meeting's
// sort key and id and only then breaks ties within the meeting.
export type SavedCursor = {
  meeting_at: string;
  meeting_id: string;
  created_at: string;
  id: string;
};
