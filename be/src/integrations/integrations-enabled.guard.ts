import { CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';

/** 연동 API 활성 여부 (integrationsEnabled(loadEnv())). 기동 시 한 번 정한다 — 테스트는 이 토큰을 덮어쓴다. */
export const INTEGRATIONS_ENABLED = Symbol('INTEGRATIONS_ENABLED');

/** 꺼진 실행(Docker·데모·비loopback)에서는 라우트가 없는 것처럼 404다 — fe는 404를 보고 연동 UI를 숨긴다. */
@Injectable()
export class IntegrationsEnabledGuard implements CanActivate {
  constructor(@Inject(INTEGRATIONS_ENABLED) private readonly enabled: boolean) {}
  canActivate(): boolean {
    if (!this.enabled) throw new NotFoundException();
    return true;
  }
}
