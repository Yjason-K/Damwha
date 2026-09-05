import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LiveService } from './live.service';

@ApiTags('live')
@Controller('meetings')
export class LiveController {
  constructor(private readonly service: LiveService) {}

  @Post('live')
  @ApiOperation({
    summary: '실시간 녹음 시작',
    description:
      '워커 Mac의 마이크로 녹음을 시작한다. recording 회의와 live_session job을 만들고 회의 행을 돌려준다. '
      + '이미 녹음 중인 회의가 있으면 409. body는 업로드와 같은 필드(JSON): title, processing, speakers, defer_lens, defer_summary.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        processing: { type: 'object', description: '처리 설정 오버라이드 — 업로드와 동일' },
        speakers: { type: 'object', description: '{"min":2,"max":5}' },
        defer_lens: { type: 'boolean' },
        defer_summary: { type: 'boolean' },
      },
    },
  })
  @HttpCode(201)
  start(@Body() body: {
    title?: unknown; processing?: unknown; speakers?: unknown; defer_lens?: unknown; defer_summary?: unknown;
  }) {
    return this.service.start(body ?? {});
  }

  @Post(':id/live/stop')
  @ApiOperation({
    summary: '실시간 녹음 종료',
    description:
      '워커가 마이크를 연 뒤면 stop_requested_at을 찍고 stopping. 아직 queued면 녹음된 게 없으니 '
      + '회의를 지우고 discarded. recording이 아니면 409.',
  })
  @HttpCode(200)
  stop(@Param('id') id: string) { return this.service.stop(id); }

  @Get(':id/live')
  @ApiOperation({ summary: '라이브 발화 조회 (seq 커서)' })
  @ApiQuery({ name: 'after', required: false, description: '이 seq 이후 행만' })
  get(@Param('id') id: string, @Query('after') after?: string) {
    return this.service.getLive(id, after);
  }
}
