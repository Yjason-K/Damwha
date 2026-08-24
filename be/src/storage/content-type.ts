import * as path from 'path';

// FE는 이 응답을 <audio src>에 그대로 물린다(pages/meeting.tsx). octet-stream을
// 흘리면 브라우저 sniff에 의존하게 되고 Safari가 FLAC을 거부할 수 있다.
const AUDIO_MIME: Record<string, string> = {
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
};

export function audioContentType(key: string): string {
  return AUDIO_MIME[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
}
