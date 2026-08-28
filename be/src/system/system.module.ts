import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { CAPABILITIES, detectCapabilities } from './capabilities';
import { CapabilitiesService } from './capabilities.service';

@Module({
  controllers: [SystemController],
  // CAPABILITIES는 이 API 프로세스가 부팅 시 1회 감지한 값 — CapabilitiesService가
  // 워커 보고를 못 찾았을 때의 폴백이자, e2e에서 갈아끼우는 지점이다.
  providers: [{ provide: CAPABILITIES, useFactory: detectCapabilities }, CapabilitiesService],
  exports: [CAPABILITIES, CapabilitiesService],
})
export class SystemModule {}
