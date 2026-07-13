import { buildCapabilities } from '../src/system/capabilities';

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
