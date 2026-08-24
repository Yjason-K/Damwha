export type SavedUtterance = {
  id: string;
  utteranceId: string | null;
  text: string;
  speakerId: string | null;
  speakerName: string | null;
  startMs: number;
  createdAt: string;
  meeting: { id: string; title: string | null; recordedAt: string | null };
};

export type SavedUtterancePage = {
  items: SavedUtterance[];
  nextCursor: string | null;
};

export type SavedUtteranceWire = {
  id: string;
  utterance_id: string | null;
  text: string;
  speaker_id: string | null;
  speaker_name: string | null;
  start_ms: number;
  created_at: string;
  meeting: { id: string; title: string | null; recorded_at: string | null };
};
