import { CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';

/** 공유 활성 여부 (shareEnabled(loadEnv())). 기동 시 한 번 정한다 — 테스트는 이 토큰을 덮어쓴다. */
export const SHARE_ENABLED = Symbol('SHARE_ENABLED');

/** 공유가 꺼진 실행(Docker·데모)에서는 라우트가 없는 것처럼 404다 — fe는 404를 보고 공유 UI를 숨긴다. */
@Injectable()
export class ShareEnabledGuard implements CanActivate {
  constructor(@Inject(SHARE_ENABLED) private readonly enabled: boolean) {}
  canActivate(): boolean {
    if (!this.enabled) throw new NotFoundException();
    return true;
  }
}
