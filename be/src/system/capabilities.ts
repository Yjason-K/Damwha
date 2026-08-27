import { execFile } from 'child_process';
import * as os from 'os';

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
}): Capabilities {
  const gpuEligible = input.platform === 'darwin' && input.arch === 'arm64';
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
  // GPU 적격성은 워커가 도는 머신의 것이지 API가 도는 머신의 것이 아니다. 배포 이미지
  // (deploy/)에서는 API가 Linux 컨테이너 안이고 워커는 호스트 Mac이라, compose가
  // 호스트 플랫폼을 이 두 env로 알려준다. 개발에선 비어 있고 프로세스 값을 쓴다.
  const platform = process.env.CAPABILITIES_PLATFORM || process.platform;
  const arch = process.env.CAPABILITIES_ARCH || process.arch;
  const chip = process.platform === 'darwin' ? await sysctlChip() : null;
  cached = buildCapabilities({
    platform,
    arch,
    totalmemBytes: os.totalmem(),
    chip,
  });
  return cached;
}
