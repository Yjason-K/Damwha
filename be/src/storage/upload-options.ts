import { diskStorage } from 'multer';
import * as os from 'os';
import * as crypto from 'crypto';
import { maxUploadBytes } from '../config/env';

export const uploadInterceptorOptions = {
  storage: diskStorage({
    destination: os.tmpdir(),
    filename: (_req: any, _file: any, cb: (err: Error | null, name: string) => void) =>
      cb(null, `dw-upload-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: maxUploadBytes() },
};
