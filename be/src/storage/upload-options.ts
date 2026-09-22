import { diskStorage } from 'multer';
import * as os from 'os';
import * as crypto from 'crypto';
import { maxUploadBytes } from '../config/env';

// Multer 2.x (busboy) decodes the multipart `filename` header as latin1, so a
// browser-sent UTF-8 filename (e.g. Korean) arrives as mojibake. Re-decode the
// raw bytes as UTF-8 when they form a valid sequence; otherwise (pure ASCII, or
// an already-correctly-decoded name) leave it untouched.
export function decodeOriginalName(name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1'));
  } catch {
    return name;
  }
}

// 이 request의 임시 업로드 파일명을 요청 스코프에 남기는 키. DiskFullFilter가
// 읽는다 — 디스크가 찬 채 쓰기(write())가 실패하면 그 예외엔 `.path`가 없다
// (open()류 에러에만 붙는다, 실측 확인: keys는 [errno, code, syscall]뿐이었다).
// 그래서 예외가 아니라 여기, 파일명이 정해지는 바로 그 자리(쓰기 시작 **전**이라
// ENOSPC보다 항상 먼저 실행된다)에 심어 둔다.
export const UPLOAD_TEMP_FILENAME_KEY = '__uploadTempFilename';

export const uploadInterceptorOptions = {
  storage: diskStorage({
    destination: os.tmpdir(),
    filename: (req: any, _file: any, cb: (err: Error | null, name: string) => void) => {
      const name = `dw-upload-${crypto.randomUUID()}`;
      req[UPLOAD_TEMP_FILENAME_KEY] = name;
      cb(null, name);
    },
  }),
  limits: { fileSize: maxUploadBytes() },
};
