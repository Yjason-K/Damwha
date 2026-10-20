import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConflictError, IntegrationCommandError } from './errors';
import { IntegrationsEnabledGuard } from './integrations-enabled.guard';
import { IntegrationsService } from './integrations.service';

/** 도메인 오류를 HttpException으로 옮긴다 — 로깅 인터셉터가 상태 코드를 제대로 읽는다. 그 밖의 오류는 그대로 던진다. */
async function mapErrors<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    if (e instanceof ConflictError) {
      throw new HttpException({ statusCode: 409, code: 'INTEGRATION_CONFLICT', message: e.message, target: e.target }, 409);
    }
    if (e instanceof IntegrationCommandError) {
      throw new HttpException({ statusCode: 500, code: 'INTEGRATION_FAILED', message: e.message, previous: e.previous }, 500);
    }
    throw e;
  }
}

/** 홈 디렉터리와 다른 프로그램의 설정을 바꾼다. 상태를 바꾸는 동작은 POST·DELETE뿐이다(GET은 읽기만). */
@ApiTags('integrations')
@UseGuards(IntegrationsEnabledGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Get()
  @ApiOperation({ summary: 'CLI 링크와 Claude Code·Codex MCP 등록 상태, 수동 설치 명령' })
  get() { return mapErrors(this.service.get()); }

  // 'cli' 라우트는 :client보다 먼저 선언한다.
  @Post('cli/install')
  @HttpCode(200)
  @ApiOperation({ summary: '~/.local/bin/damwha 링크 설치' })
  installCli() { return mapErrors(this.service.installCli()); }

  @Delete('cli')
  @HttpCode(204)
  @ApiOperation({ summary: '담화 링크 제거' })
  async removeCli() { await mapErrors(this.service.removeCli()); }

  @Post(':client/install')
  @HttpCode(200)
  @ApiOperation({ summary: 'MCP 등록 (링크가 없으면 먼저 설치)' })
  installClient(@Param('client') client: string, @Body() body: { replace?: unknown } | undefined) {
    return mapErrors(this.service.installClient(client, body?.replace === true));
  }

  @Delete(':client')
  @HttpCode(204)
  @ApiOperation({ summary: '담화가 등록한 MCP 항목 제거' })
  async removeClient(@Param('client') client: string) { await mapErrors(this.service.removeClient(client)); }
}
