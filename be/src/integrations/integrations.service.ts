import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { join } from 'node:path';
import { inspectLink, installLink, removeLink, type LinkFs, type LinkState } from './cli-link';
import {
  clientState,
  manualCommands,
  registerClient,
  unregisterClient,
  type ClientId,
  type ClientState,
  type Run,
} from './clients';
import { findExecutable, loginShellPath } from './find-executable';

/** 파일시스템·명령 실행·환경을 한 덩어리로 주입한다 — 테스트는 이 토큰을 덮어써 실제 홈을 건드리지 않는다. */
export type IntegrationsDeps = {
  launcher: string;
  home: string;
  shell: string | undefined;
  pathEnv: string;
  fs: LinkFs;
  run: Run;
  isExecutable(path: string): Promise<boolean>;
};
export const INTEGRATIONS_DEPS = Symbol('INTEGRATIONS_DEPS');

export const CLIENT_IDS: ClientId[] = ['claude-code', 'codex'];
const BIN_NAME: Record<ClientId, 'claude' | 'codex'> = { 'claude-code': 'claude', codex: 'codex' };

@Injectable()
export class IntegrationsService {
  constructor(@Inject(INTEGRATIONS_DEPS) private readonly d: IntegrationsDeps) {}

  private get linkPath() { return join(this.d.home, '.local', 'bin', 'damwha'); }

  private parseClient(id: string): ClientId {
    if (!(CLIENT_IDS as string[]).includes(id)) throw new NotFoundException();
    return id as ClientId;
  }

  private bin(id: ClientId) {
    return findExecutable(BIN_NAME[id], this.d);
  }

  async get() {
    const link = await inspectLink(this.linkPath, this.d.launcher, this.d.fs);
    const clients = {} as Record<ClientId, ClientState>;
    for (const id of CLIENT_IDS) {
      // 한 클라이언트의 설정이 깨져도 나머지와 링크 상태는 보여 준다.
      try {
        clients[id] = await clientState(id, await this.bin(id), this.linkPath, this.d.run);
      } catch (e) {
        clients[id] = { installed: true, registration: { error: e instanceof Error ? e.message : String(e) } };
      }
    }
    // 사용자가 터미널에서 `damwha`를 칠 때의 PATH가 기준이다 — API 프로세스의 PATH가 아니다.
    const pathEnv = (await loginShellPath(this.d)) ?? this.d.pathEnv;
    return {
      cli: {
        link,
        link_path: this.linkPath,
        on_path: pathEnv.split(':').includes(join(this.d.home, '.local', 'bin')),
      },
      clients,
      manual: manualCommands(this.linkPath, this.d.launcher),
    };
  }

  installCli(): Promise<LinkState> {
    return installLink(this.linkPath, this.d.launcher, this.d.fs);
  }

  removeCli(): Promise<void> {
    return removeLink(this.linkPath, this.d.launcher, this.d.fs);
  }

  async installClient(rawId: string, replace: boolean): Promise<ClientState> {
    const id = this.parseClient(rawId);
    const bin = await this.bin(id);
    // 클라이언트가 없으면 링크도 만들지 않는다 — 쓸 곳 없는 파일을 홈에 남기지 않는다.
    if (!bin) return { installed: false };
    const link = await inspectLink(this.linkPath, this.d.launcher, this.d.fs);
    if (link.kind !== 'current') await this.installCli();
    return registerClient(id, bin, this.linkPath, this.d.run, { replace });
  }

  async removeClient(rawId: string): Promise<void> {
    const id = this.parseClient(rawId);
    await unregisterClient(id, await this.bin(id), this.linkPath, this.d.run);
  }
}
