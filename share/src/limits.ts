/** IP별 고정 창 제한. 프로세스 하나라 메모리 Map으로 충분하다. */
export class WindowLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  allow(key: string, now: number): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }

  private prune(now: number) {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
  }
}

export type BudgetTicket = { day: string; size: number };

/**
 * 서비스 전체 일일 업로드 상한 (spec selfhost-v2 §2.4). 확인과 차감이 await 없이 한 번에 일어나므로 동시 요청이
 * 몰려도 상한을 넘지 않는다 — 프로세스 하나가 전제다. 메모리 카운터라 재시작하면 0부터 다시 센다.
 * 예약은 날짜가 든 표를 돌려주고, 취소는 그 날짜의 카운터에서만 뺀다 — 자정을 넘긴 실패가 새 날을 줄이지 않는다.
 */
export class DailyBudget {
  private day = '';
  private count = 0;
  private bytes = 0;
  constructor(private readonly maxUploads: number, private readonly maxBytes: number) {}

  reserve(size: number, now: Date): BudgetTicket | null {
    const d = now.toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.count = 0;
      this.bytes = 0;
    }
    if (this.count + 1 > this.maxUploads || this.bytes + size > this.maxBytes) return null;
    this.count++;
    this.bytes += size;
    return { day: d, size };
  }

  release(ticket: BudgetTicket): void {
    if (ticket.day !== this.day) return;
    this.count = Math.max(0, this.count - 1);
    this.bytes = Math.max(0, this.bytes - ticket.size);
  }
}
