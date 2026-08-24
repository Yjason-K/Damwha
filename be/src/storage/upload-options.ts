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

export const uploadInterceptorOptions = {
  storage: diskStorage({
    destination: os.tmpdir(),
    filename: (_req: any, _file: any, cb: (err: Error | null, name: string) => void) =>
      cb(null, `dw-upload-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: maxUploadBytes() },
};
