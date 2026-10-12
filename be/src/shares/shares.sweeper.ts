import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SHARE_ENABLED } from './share-enabled.guard';
import { SharesService } from './shares.service';

/**
 * 공유의 뒷정리 (spec §2.7): 기동 시와 5분마다 만료 정리 -> 오래된 creating 정리 -> 철회 재시도.
 * 오프라인에서 지운 회의의 링크가 여기서 다시 연결될 때 철회된다. 공유가 꺼진 실행에서는 아무것도 하지 않는다.
 */
@Injectable()
export class SharesSweeper implements OnApplicationBootstrap {
  /** 기동 스위프의 완료. 테스트가 기다려 자기 준비 행과 겹치지 않게 한다. */
  ready: Promise<void> = Promise.resolve();

  constructor(@Inject(SHARE_ENABLED) private readonly enabled: boolean, private readonly service: SharesService) {}

  onApplicationBootstrap(): void {
    // 기동을 붙잡지 않는다 — 공유 서버가 안 닿으면 타임아웃까지 걸린다. sweep()은 오류를 삼킨다(경고 로그만).
    this.ready = this.tick();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (!this.enabled) return;
    await this.service.sweep();
  }
}
