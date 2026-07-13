import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Capabilities, CAPABILITIES } from './capabilities';

@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(@Inject(CAPABILITIES) private readonly caps: Capabilities) {}

  @Get('capabilities')
  @ApiOperation({ summary: '머신 스펙 감지 + 추천 프리셋 (gpu_eligible = 하드웨어 적합성만)' })
  capabilities() {
    return this.caps;
  }
}
