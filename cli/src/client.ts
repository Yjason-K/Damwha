import type {
  Folder,
  LensItem,
  LensPage,
  LensQuery,
  MeetingDetail,
  MeetingPage,
  MeetingStatus,
  ModelInfo,
  SearchBody,
  SearchResponse,
  Speaker,
  TranscriptPage,
} from './api-types';
import { ApiRequestError } from './errors';

type Query = Record<string, string | number | undefined>;

/** Nest 오류 본문 `{ statusCode, message, error, code? }`에서 사람이 읽을 메시지를 뽑는다. */
async function toError(res: Response): Promise<ApiRequestError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { message?: string | string[]; code?: string };
    if (Array.isArray(body.message)) message = body.message.join(', ');
    else if (typeof body.message === 'string') message = body.message;
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // JSON이 아닌 본문(프록시 오류 등)은 상태 코드만 남긴다.
  }
  return new ApiRequestError(message, res.status, code);
}

export class DamwhaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init?: RequestInit, query?: Query): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.baseUrl}${path}${qs.size ? `?${qs}` : ''}`;
    const res = await this.fetchImpl(url, init);
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(
      path,
      body === undefined
        ? { method: 'POST' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
  }

  listLenses(q: LensQuery): Promise<LensPage> {
    const { due_from, due_to, ...rest } = q;
    return this.request('/lenses', undefined, { ...rest, date_from: due_from, date_to: due_to });
  }

  getLens(id: string): Promise<LensItem> {
    return this.request(`/lenses/${encodeURIComponent(id)}`);
  }

  completeLens(id: string): Promise<LensItem> {
    return this.post(`/lenses/${encodeURIComponent(id)}/complete`);
  }

  listMeetings(p: { limit?: number; cursor?: string }): Promise<MeetingPage> {
    return this.request('/meetings', undefined, p);
  }

  getMeeting(id: string): Promise<MeetingDetail> {
    return this.request(`/meetings/${encodeURIComponent(id)}`);
  }

  getTranscript(id: string, p: { offset?: number; limit?: number }): Promise<TranscriptPage> {
    return this.request(`/meetings/${encodeURIComponent(id)}/transcript`, undefined, p);
  }

  getStatus(id: string): Promise<MeetingStatus> {
    return this.request(`/meetings/${encodeURIComponent(id)}/status`);
  }

  search(body: SearchBody): Promise<SearchResponse> {
    return this.post('/search', body);
  }

  listSpeakers(): Promise<Speaker[]> {
    return this.request('/speakers');
  }

  listFolders(): Promise<Folder[]> {
    return this.request('/folders');
  }

  listModels(): Promise<ModelInfo> {
    return this.request('/models');
  }

  /** multipart는 fetch가 경계 문자열 포함 content-type을 직접 붙이도록 헤더를 건드리지 않는다. */
  upload(form: FormData): Promise<{ id: string; [key: string]: unknown }> {
    return this.request('/meetings', { method: 'POST', body: form });
  }
}
