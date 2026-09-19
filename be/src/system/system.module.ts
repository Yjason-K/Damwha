import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { CAPABILITIES, detectCapabilities } from './capabilities';
import { CapabilitiesService } from './capabilities.service';
import { ModelReadinessService } from './model-readiness.service';

@Module({
  controllers: [SystemController],
  // CAPABILITIES는 이 API 프로세스가 부팅 시 1회 감지한 값 — CapabilitiesService가
  // 워커 보고를 못 찾았을 때의 폴백이자, e2e에서 갈아끼우는 지점이다.
  // ModelReadinessService는 app_setting의 두 번째 단방향 행(model_readiness)을 읽는다
  // (Phase 4 스펙 §6.9). 설정 조회가 그것을 응답에 얹으므로 여기서 내보낸다.
  providers: [
    { provide: CAPABILITIES, useFactory: detectCapabilities },
    CapabilitiesService,
    ModelReadinessService,
  ],
  exports: [CAPABILITIES, CapabilitiesService, ModelReadinessService],
})
export class SystemModule {}
