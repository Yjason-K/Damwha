import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CapabilitiesService } from './capabilities.service';

@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(private readonly caps: CapabilitiesService) {}

  @Get('capabilities')
  @ApiOperation({ summary: '머신 스펙 (워커 실측 우선) + 추천 프리셋' })
  capabilities() {
    return this.caps.get();
  }
}
