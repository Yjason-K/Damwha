import { ReaperService } from '../src/jobs/reaper.service';

describe('ReaperService.onApplicationBootstrap', () => {
  const pool = {} as never;
  const db = { pool } as never;
  const original = process.env.WORKER_ID;
  process.env.DATABASE_URL ??= 'postgres://x/y';
  afterEach(() => {
    if (original === undefined) delete process.env.WORKER_ID;
    else process.env.WORKER_ID = original;
  });

  it('reclaims with this run’s worker id when the app launched the API', async () => {
    process.env.WORKER_ID = 'desktop-abc';
    const jobs = { reclaimOrphaned: jest.fn().mockResolvedValue({ requeued: 2, failedLive: 1 }) };
    const svc = new ReaperService(db, jobs as never);
    await svc.onApplicationBootstrap();
    expect(jobs.reclaimOrphaned).toHaveBeenCalledWith(pool, 'desktop-abc');
  });

  it('does nothing when WORKER_ID is absent (web deployment)', async () => {
    delete process.env.WORKER_ID;
    const jobs = { reclaimOrphaned: jest.fn() };
    const svc = new ReaperService(db, jobs as never);
    await svc.onApplicationBootstrap();
    expect(jobs.reclaimOrphaned).not.toHaveBeenCalled();
  });

  it('does nothing when WORKER_ID is not an app worker id', async () => {
    // 경계를 한 군데(`isAppWorkerId`)에서만 정한다. 터미널 worker의 신분으로 뜬 API가
    // 앱이 남긴 desktop-* 행을 건드리지 않는다.
    process.env.WORKER_ID = 'worker-1';
    const jobs = { reclaimOrphaned: jest.fn() };
    const svc = new ReaperService(db, jobs as never);
    await svc.onApplicationBootstrap();
    expect(jobs.reclaimOrphaned).not.toHaveBeenCalled();
  });

  it('does not stop startup when the reclaim query fails', async () => {
    process.env.WORKER_ID = 'desktop-abc';
    const jobs = { reclaimOrphaned: jest.fn().mockRejectedValue(new Error('boom')) };
    const svc = new ReaperService(db, jobs as never);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
