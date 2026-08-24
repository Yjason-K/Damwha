export type SavedUtteranceRow = {
  id: string;
  utterance_id: string | null;
  text: string;
  speaker_name: string | null;
  start_ms: number;
  created_at: Date;
  meeting_id: string;
  meeting_title: string | null;
  recorded_at: Date | null;
};

export type SavedCursor = { created_at: string; id: string };
