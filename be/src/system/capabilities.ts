import { execFile } from 'child_process';
import * as os from 'os';
import { z } from 'zod';

export const CAPABILITIES = 'CAPABILITIES';

export interface Capabilities {
  platform: string;
  arch: string;
  chip: string | null;
  memory_gb: number;
  gpu_eligible: boolean;
  recommended_preset: 'light' | 'standard' | 'quality' | null;
}

export function buildCapabilities(input: {
  platform: string;
  arch: string;
  totalmemBytes: number;
  chip: string | null;
  /** 실측값이 있을 때만 — 없으면 platform/arch에서 추정한다. */
  gpuEligible?: boolean;
}): Capabilities {
  const gpuEligible = input.gpuEligible ?? (input.platform === 'darwin' && input.arch === 'arm64');
  const memoryGb = Math.round(input.totalmemBytes / 1024 ** 3);
  // 모든 프리셋이 diarization gpu를 포함 — 비적격 환경엔 추천 불가 (spec §3)
  const recommended = !gpuEligible
    ? null
    : memoryGb < 16
      ? ('light' as const)
      : memoryGb < 48
        ? ('standard' as const)
        : ('quality' as const);
  return {
    platform: input.platform,
    arch: input.arch,
    chip: input.chip,
    memory_gb: memoryGb,
    gpu_eligible: gpuEligible,
    recommended_preset: recommended,
  };
}

function sysctlChip(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 1000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

let cached: Capabilities | null = null;
export async function detectCapabilities(): Promise<Capabilities> {
  if (cached) return cached;
  // 스펙 전체가 워커가 도는 머신의 것이지 API가 도는 머신의 것이 아니다. 배포 이미지
  // (deploy/)에서는 API가 Linux 컨테이너 안이고 워커는 호스트 Mac이라, compose가
  // 호스트 값을 이 env들로 알려준다. 개발에선 비어 있고 프로세스 값을 쓴다.
  const platform = process.env.CAPABILITIES_PLATFORM || process.platform;
  const arch = process.env.CAPABILITIES_ARCH || process.arch;
  // 컨테이너 안의 os.totalmem()은 Docker Desktop VM 할당량이지 Mac의 RAM이 아니다 —
  // 그대로 두면 "내 머신" 카드가 작은 값을 보이고 추천 프리셋이 light로 눌러앉는다.
  const envMemoryGb = Number(process.env.CAPABILITIES_MEMORY_GB);
  const totalmemBytes =
    Number.isFinite(envMemoryGb) && envMemoryGb > 0 ? envMemoryGb * 1024 ** 3 : os.totalmem();
  // sysctl 실행 가능 여부는 실제 프로세스 플랫폼이 정한다 — env의 darwin은 호스트
  // 주장일 뿐 이 프로세스가 macOS라는 뜻이 아니다 (컨테이너엔 sysctl이 없다).
  const chip =
    process.env.CAPABILITIES_CHIP || (process.platform === 'darwin' ? await sysctlChip() : null);
  cached = buildCapabilities({
    platform,
    arch,
    totalmemBytes,
    chip,
  });
  return cached;
}

export const WORKER_CAPABILITIES_KEY = 'worker_capabilities';

/**
 * 워커가 `app_setting`에 적어두는 자기 머신 관측값 — Python 쪽
 * `damwha_worker/capabilities.py`와 짝을 이루는 계약이다. job 페이로드와 달리
 * **단방향**(워커 write / API read)이라 pydantic 짝이 없고 zod만 있다. 워커가 나중에
 * 필드를 더 붙여도 API가 깨지지 않도록 strict가 아니다 (진단용 `gpu_probe`가 그렇게
 * 실려 오고, 여기서 조용히 버려진다).
 */
export const WorkerCapabilitiesSchema = z.object({
  worker_id: z.string(),
  platform: z.string(),
  arch: z.string(),
  chip: z.string().nullable(),
  memory_gb: z.number().int().positive(),
  gpu_eligible: z.boolean(),
});
export type WorkerCapabilities = z.infer<typeof WorkerCapabilitiesSchema>;

/**
 * 워커 보고가 있으면 그것이 진실이다 — GPU를 실제로 쓰는 머신이 워커가 도는 머신이고,
 * `gpu_eligible`도 거기서 MPS를 재본 결과다. env 추정과 달리 Rosetta python을 걸러낸다.
 */
export function fromWorkerReport(r: WorkerCapabilities): Capabilities {
  return buildCapabilities({
    platform: r.platform,
    arch: r.arch,
    chip: r.chip,
    totalmemBytes: r.memory_gb * 1024 ** 3,
    gpuEligible: r.gpu_eligible,
  });
}
