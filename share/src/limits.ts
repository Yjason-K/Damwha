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

export type ClientTicket = { key: string; ticket: BudgetTicket };

/**
 * 클라이언트(clientKey)별 일일 업로드 쿼터 (이슈 #106 DCS-1) — 한 클라이언트가 전역 상한을 혼자 다 쓰지 못하게 한다.
 * 날짜가 바뀌면 전부 비운다. 전역 예약이 된 뒤에만 부르므로 하루 항목 수는 전역 건수 상한을 넘지 않는다.
 */
export class ClientDailyBudget {
  private day = '';
  private readonly budgets = new Map<string, DailyBudget>();
  constructor(private readonly maxUploads: number, private readonly maxBytes: number) {}

  reserve(key: string, size: number, now: Date): ClientTicket | null {
    const d = now.toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.budgets.clear();
    }
    let b = this.budgets.get(key);
    if (!b) this.budgets.set(key, (b = new DailyBudget(this.maxUploads, this.maxBytes)));
    const ticket = b.reserve(size, now);
    return ticket && { key, ticket };
  }

  release(t: ClientTicket): void {
    this.budgets.get(t.key)?.release(t.ticket);
  }
}

/**
 * 제한·쿼터를 셀 클라이언트 키. IPv6는 /64로 묶는다 — 가정 회선 하나가 /64를 통째로 받으므로 주소를 바꿔 가며
 * 제한을 피하지 못하게 한다. IPv4에 대응된 IPv6(::ffff:a.b.c.d)는 IPv4로, 해석할 수 없는 값은 그대로 쓴다.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const addr = ip.split('%')[0]!;
  const halves = addr.split('::');
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return ip;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
