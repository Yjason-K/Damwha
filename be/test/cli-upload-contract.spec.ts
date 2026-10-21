import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProcessingOverrideSchema } from '../src/settings/resolve-processing';
import { SpeakerBoundsSchema } from '../src/meetings/speaker-bounds';
// 빌드 산출물이 아니라 CLI 소스를 직접 가져온다 — CLI가 만든 multipart가 be 파서를 통과하는지 고정한다.
import { buildUploadForm, parseUploadOptions } from '../../cli/src/upload-options';

// 과거에 프런트가 낡은 열거 문자열을 보내 API가 'Invalid input'만 답한 적이 있다.
// CLI·MCP가 보내는 조합이 be의 zod 스키마와 어긋나면 여기서 먼저 깨진다.
const combos: Record<string, unknown>[] = [
  { preset: 'light' },
  { preset: 'quality', language: 'ko' },
  { 'whisper-model': 'large-v3-turbo', language: 'auto' },
  { 'stt-device': 'gpu', 'diarization-device': 'cpu' },
  { preset: 'standard', 'whisper-model': 'small', 'stt-device': 'cpu', 'diarization-device': 'gpu', language: 'ja' },
  { speakers: '4', 'min-speakers': undefined, language: 'zh', 'diarization-device': 'cpu' },
  { 'min-speakers': '2' },
  { 'max-speakers': '6', 'stt-device': 'cpu' },
  { 'min-speakers': '2', 'max-speakers': '6', language: 'en' },
];

describe('CLI upload options vs be upload parser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-contract-'));
  const file = join(dir, 'a.m4a');
  writeFileSync(file, 'x');

  it.each(combos.map((c, i) => [i, c] as const))('combo %i is accepted', async (_i, raw) => {
    const form = await buildUploadForm(file, parseUploadOptions(raw), undefined, new Date());
    const processing = form.get('processing');
    if (processing !== null) {
      expect(ProcessingOverrideSchema.safeParse(JSON.parse(processing as string)).success).toBe(true);
    }
    const speakers = form.get('speakers');
    if (speakers !== null) {
      expect(SpeakerBoundsSchema.safeParse(JSON.parse(speakers as string)).success).toBe(true);
    }
  });
});
