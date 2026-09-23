import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { PutProcessingValueSchema, resolveStoredValue } from './processing-config';
import { CapabilitiesService } from '../system/capabilities.service';
import { ModelReadinessService } from '../system/model-readiness.service';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly service: SettingsService,
    private readonly caps: CapabilitiesService,
    private readonly readiness: ModelReadinessService,
  ) {}

  /**
   * 처리 기본 설정 + **모델 준비 상태** (Phase 4 스펙 §6.9 — "API가 기존 설정 조회 응답에
   * modelReadiness로 얹고, 앱 상태 창과 FE가 같은 값을 본다").
   *
   * `modelReadiness`는 **곁가지**라 `ProcessingConfig` 안에 넣지 않는다 — 그 타입은 enqueue가
   * job 페이로드를 만들 때도 쓰는 resolved 뷰이고, 거기에 준비 상태가 섞이면 job에 실려 나간다.
   * PUT 응답에도 싣지 않는다: 쓰기의 결과는 저장된 설정이지 그 순간의 다운로드 진행이 아니다.
   *
   * API는 이 행을 **쓰지 않는다** (ModelReadinessService의 주석).
   */
  @Get('processing')
  @ApiOperation({ summary: '처리 기본 설정 (resolved 뷰) + 모델 준비 상태 (읽기 전용)' })
  async get() {
    const [config, modelReadiness] = await Promise.all([
      this.service.getProcessingConfig(),
      this.readiness.get(),
    ]);
    return { ...config, modelReadiness };
  }

  @Put('processing')
  @ApiOperation({ summary: '처리 기본 설정 변경 — 이름 프리셋은 이름만, custom은 전 필드' })
  async put(@Body() body: unknown) {
    const parsed = PutProcessingValueSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    const v = parsed.data;
    // 이름 프리셋도 gpu를 품는다(light: diar gpu) — 반드시 완전 해석 후 검사 (spec §3)
    const resolved = resolveStoredValue(v);
    const caps = await this.caps.get();
    if (!caps.gpu_eligible &&
        (resolved.devices.diarization === 'gpu' || resolved.devices.stt === 'gpu')) {
      throw new BadRequestException('gpu is not available on this machine (gpu_eligible=false)');
    }
    return this.service.putProcessing(v);
  }
}
