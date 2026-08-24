import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { DeviceSchema, WHISPER_MODELS } from '../contracts/job-payload.schema';
import { ProcessingConfig, resolvePreset } from './presets';

// job 오버라이드 — PUT 스키마와 별개(혼합 허용, 의도된 비대칭; spec §5)
export const ProcessingOverrideSchema = z.object({
  preset: z.enum(['light', 'standard', 'quality']).optional(),
  whisper_model: z.enum(WHISPER_MODELS).optional(),
  devices: z.object({ diarization: DeviceSchema.optional(), stt: DeviceSchema.optional() })
    .strict()
    .refine((d) => d.diarization !== undefined || d.stt !== undefined,
            'devices must set diarization or stt')
    .optional(),
  language: z.string().trim().min(1).optional(),
}).strict();
export type ProcessingOverride = z.infer<typeof ProcessingOverrideSchema>;

export function resolveProcessingConfig(
  global: ProcessingConfig, override: ProcessingOverride | undefined, gpuEligible: boolean,
): ProcessingConfig {
  let cfg = global;
  if (override?.preset) cfg = resolvePreset(override.preset, override.language ?? global.language);
  const individual = override && (override.whisper_model !== undefined ||
    override.devices !== undefined || override.language !== undefined);
  if (override && individual) {
    cfg = {
      preset: 'custom',
      preset_revision: null,
      language: override.language ?? cfg.language,
      whisper_model: override.whisper_model ?? cfg.whisper_model,
      devices: {
        diarization: override.devices?.diarization ?? cfg.devices.diarization,
        stt: override.devices?.stt ?? cfg.devices.stt,
      },
    };
  }
  if (!gpuEligible && (cfg.devices.diarization === 'gpu' || cfg.devices.stt === 'gpu')) {
    throw new BadRequestException('gpu is not available on this machine (gpu_eligible=false)');
  }
  return cfg;
}
