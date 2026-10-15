export interface ShareConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Docker 이미지는 NODE_ENV=production. 그때는 개발용 설정(DEV_EXPIRY_SECONDS)을 읽지 않는다. */
  production: boolean;
  uploadsEnabled: boolean;
  dailyMaxUploads: number;
  dailyMaxBytes: number;
  devExpirySeconds: number | null;
  /** IP당 분당 요청 수 — 업로드·조회·삭제를 따로 센다 (Task 4). */
  limits: { upload: number; read: number; delete: number };
}

const positive = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function readConfig(env: Record<string, string | undefined>): ShareConfig {
  const production = env.NODE_ENV === 'production';
  const dev = Number(env.DEV_EXPIRY_SECONDS);
  return {
    port: positive(env.PORT, 8787),
    host: env.HOST ?? '127.0.0.1',
    dataDir: env.DATA_DIR ?? './.data',
    production,
    uploadsEnabled: env.UPLOADS_ENABLED !== 'false',
    dailyMaxUploads: positive(env.DAILY_MAX_UPLOADS, 500),
    dailyMaxBytes: positive(env.DAILY_MAX_BYTES, 524_288_000),
    devExpirySeconds: !production && env.DEV_EXPIRY_SECONDS && Number.isFinite(dev) && dev > 0 ? dev : null,
    limits: {
      upload: positive(env.UPLOAD_LIMIT_PER_MIN, 10),
      read: positive(env.READ_LIMIT_PER_MIN, 120),
      delete: positive(env.DELETE_LIMIT_PER_MIN, 30),
    },
  };
}
