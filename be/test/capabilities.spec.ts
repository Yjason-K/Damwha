import {
  buildCapabilities, fromWorkerReport, WorkerCapabilitiesSchema, Capabilities,
} from '../src/system/capabilities';
import { CapabilitiesService } from '../src/system/capabilities.service';

const GB = 1024 ** 3;
describe('buildCapabilities', () => {
  it('arm64 darwin 32GB → standard', () => {
    const c = buildCapabilities({ platform: 'darwin', arch: 'arm64', totalmemBytes: 32 * GB, chip: 'Apple M2 Pro' });
    expect(c).toEqual({
      platform: 'darwin', arch: 'arm64', chip: 'Apple M2 Pro', memory_gb: 32,
      gpu_eligible: true, recommended_preset: 'standard',
    });
  });
  it('RAM 경계: 8GB → light, 16GB → standard, 48GB → quality, 64GB → quality', () => {
    const at = (gb: number) =>
      buildCapabilities({ platform: 'darwin', arch: 'arm64', totalmemBytes: gb * GB, chip: null }).recommended_preset;
    expect(at(8)).toBe('light');
    expect(at(16)).toBe('standard');
    expect(at(48)).toBe('quality');
    expect(at(64)).toBe('quality');
  });
  it('비 ARM Mac → gpu_eligible false + recommended null (spec §3: 미지원 환경)', () => {
    const c = buildCapabilities({ platform: 'linux', arch: 'x64', totalmemBytes: 64 * GB, chip: null });
    expect(c.gpu_eligible).toBe(false);
    expect(c.recommended_preset).toBeNull();
  });
});

describe('detectCapabilities env overrides', () => {
  const KEYS = [
    'CAPABILITIES_PLATFORM',
    'CAPABILITIES_ARCH',
    'CAPABILITIES_MEMORY_GB',
    'CAPABILITIES_CHIP',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // detectCapabilities memoizes at module scope — reload it per case.
    jest.resetModules();
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const load = () =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../src/system/capabilities').detectCapabilities() as Promise<
      import('../src/system/capabilities').Capabilities
    >;

  it('컨테이너 안의 API가 호스트 Mac 스펙을 그대로 보고한다', async () => {
    process.env.CAPABILITIES_PLATFORM = 'darwin';
    process.env.CAPABILITIES_ARCH = 'arm64';
    process.env.CAPABILITIES_MEMORY_GB = '64';
    process.env.CAPABILITIES_CHIP = 'Apple M3 Max';
    const c = await load();
    expect(c).toEqual({
      platform: 'darwin', arch: 'arm64', chip: 'Apple M3 Max', memory_gb: 64,
      gpu_eligible: true, recommended_preset: 'quality',
    });
  });

  it('빈/유효하지 않은 메모리 env는 무시하고 프로세스 값으로 떨어진다', async () => {
    process.env.CAPABILITIES_MEMORY_GB = '';
    const empty = await load();
    expect(empty.memory_gb).toBe(Math.round(require('os').totalmem() / 1024 ** 3));

    jest.resetModules();
    process.env.CAPABILITIES_MEMORY_GB = 'lots';
    const nan = await load();
    expect(nan.memory_gb).toBe(empty.memory_gb);

    jest.resetModules();
    process.env.CAPABILITIES_MEMORY_GB = '0';
    const zero = await load();
    expect(zero.memory_gb).toBe(empty.memory_gb);
  });

  it('결과를 메모이즈해서 두 번째 호출이 env 변경을 무시한다', async () => {
    process.env.CAPABILITIES_MEMORY_GB = '32';
    const mod = require('../src/system/capabilities');
    const first = await mod.detectCapabilities();
    process.env.CAPABILITIES_MEMORY_GB = '8';
    expect(await mod.detectCapabilities()).toBe(first);
  });
});

describe('fromWorkerReport', () => {
  const report = {
    worker_id: 'worker-1', platform: 'darwin', arch: 'arm64',
    chip: 'Apple M2', memory_gb: 16, gpu_eligible: true,
  };

  it('워커 실측값이 그대로 스펙이 되고 추천 프리셋도 거기서 다시 나온다', () => {
    expect(fromWorkerReport(report)).toEqual({
      platform: 'darwin', arch: 'arm64', chip: 'Apple M2', memory_gb: 16,
      gpu_eligible: true, recommended_preset: 'standard',
    });
  });

  it('darwin/arm64인데 워커가 MPS를 못 봤으면 gpu_eligible=false (Rosetta 등)', () => {
    // env 추측(platform+arch)만으로는 절대 못 만드는 조합 — 실측이라야 나온다.
    const c = fromWorkerReport({ ...report, gpu_eligible: false });
    expect(c.gpu_eligible).toBe(false);
    expect(c.recommended_preset).toBeNull();
  });

  it('진단용 여분 필드(gpu_probe)는 계약을 깨지 않고 버려진다', () => {
    const parsed = WorkerCapabilitiesSchema.safeParse({ ...report, gpu_probe: 'mps_available' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty('gpu_probe');
  });

  it('memory_gb가 0/음수면 보고를 거부한다 (부분 보고 방지)', () => {
    expect(WorkerCapabilitiesSchema.safeParse({ ...report, memory_gb: 0 }).success).toBe(false);
  });
});

describe('CapabilitiesService', () => {
  const BASE: Capabilities = {
    platform: 'linux', arch: 'x64', chip: null, memory_gb: 8,
    gpu_eligible: false, recommended_preset: null,
  };
  const REPORT = {
    worker_id: 'worker-1', platform: 'darwin', arch: 'arm64',
    chip: 'Apple M2', memory_gb: 64, gpu_eligible: true,
  };
  const svc = (query: jest.Mock) =>
    new CapabilitiesService({ pool: { query } } as never, BASE);

  it('워커 보고가 있으면 그것이 이긴다 — 컨테이너 추정이 아니라 호스트 실측', async () => {
    const c = await svc(jest.fn().mockResolvedValue({ rows: [{ value: REPORT }] })).get();
    expect(c.gpu_eligible).toBe(true);
    expect(c.memory_gb).toBe(64);
    expect(c.chip).toBe('Apple M2');
  });

  it('보고가 없으면 부팅 시 감지값으로 폴백한다 (워커 미기동/구버전)', async () => {
    expect(await svc(jest.fn().mockResolvedValue({ rows: [] })).get()).toEqual(BASE);
  });

  it('DB가 죽어 있어도 폴백만 하고 던지지 않는다 — 업로드 경로가 이걸 통과한다', async () => {
    expect(await svc(jest.fn().mockRejectedValue(new Error('down'))).get()).toEqual(BASE);
  });

  it('망가진 행은 무시하고 폴백한다', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ value: { arch: 'arm64' } }] });
    expect(await svc(query).get()).toEqual(BASE);
  });

  it('TTL 안에서는 DB를 다시 읽지 않는다', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ value: REPORT }] });
    const s = svc(query);
    await s.get();
    await s.get();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
