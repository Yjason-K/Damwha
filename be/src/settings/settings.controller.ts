import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { PutProcessingValueSchema, resolveStoredValue } from './processing-config';
import { CapabilitiesService } from '../system/capabilities.service';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly service: SettingsService,
    private readonly caps: CapabilitiesService,
  ) {}

  @Get('processing')
  @ApiOperation({ summary: '처리 기본 설정 (resolved 뷰)' })
  get() {
    return this.service.getProcessingConfig();
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
