import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../config/env';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

@Injectable()
export class EmbedClient {
  private readonly logger = new Logger(EmbedClient.name);
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly expectedDim: number;
  private readonly expectedModel: string;

  constructor() {
    const env = loadEnv();
    this.url = env.EMBED_SERVICE_URL;
    this.timeoutMs = env.EMBED_SERVICE_TIMEOUT_MS;
    this.expectedDim = env.SEARCH_EMBEDDING_DIM;
    this.expectedModel = env.SEARCH_EMBEDDING_MODEL;
    const host = new URL(this.url).hostname;
    if (!LOOPBACK.has(host) && env.EMBED_SERVICE_ALLOW_NON_LOOPBACK !== 'true') {
      throw new Error(
        `EMBED_SERVICE_URL host "${host}" is not loopback; set EMBED_SERVICE_ALLOW_NON_LOOPBACK=true to override`,
      );
    }
  }

  /** 쿼리 텍스트 → 벡터. 장애 시 null(키워드 전용 degrade). */
  async embed(text: string): Promise<number[] | null> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: [text] }),
        signal: ctrl.signal,
      });
      if (!res.ok) { this.logger.warn(`embed service ${res.status} → degrade`); return null; }
      const body = (await res.json()) as { model?: string; dimension: number; vectors: number[][] };
      // 같은 1024차원 타 모델은 서로 다른 벡터공간 → model/차원/개수/길이/유한성 전부 검증.
      // 하나라도 어긋나면 잘못된 벡터공간 비교를 막기 위해 키워드 전용으로 degrade.
      const v = body.vectors?.[0];
      if (
        body.model !== this.expectedModel ||
        body.dimension !== this.expectedDim ||
        body.vectors?.length !== 1 ||
        v?.length !== this.expectedDim ||
        !v.every(Number.isFinite)
      ) {
        this.logger.error(
          `embed rejected (model=${body.model} dim=${body.dimension} count=${body.vectors?.length}) → degrade`,
        );
        return null;
      }
      return v;
    } catch (e) {
      this.logger.warn(`embed service unreachable (${(e as Error).name}) → degrade`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}
