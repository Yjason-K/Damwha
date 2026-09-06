import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
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
      'X-Audio-Offset(자투리 시작 오프셋)과 X-Final-Offset(최종 PCM 바이트 수) 헤더, 마지막 '
      + '자투리 PCM(0바이트 가능) body가 필요하다. 봉인과 마지막 청크를 한 요청으로 묶어 그 사이 '
      + '창을 없앤다. 정상: 자투리를 append하고 봉인. 재시도(자투리가 이미 파일에 있음): append '
      + '없이 봉인만 재개. 그 외 오프셋 불일치는 missing_chunk 409. 이미 봉인된 job에 같은 '
      + 'X-Final-Offset으로 다시 오면 200 멱등, 다르면 409. 워커가 아직 claim하지 않은 세션은 '
      + 'API가 직접 마무리한다 — 0바이트면 회의를 지우고 discarded, 그 외는 uploaded로 올리고 '
      + 'process_meeting을 큐잉해 finalized. 이미 워커가 잡고 있으면 stop_requested_at만 찍고 '
      + 'stopping(워커가 마무리한다). recording이 아니면 409, 회의가 없으면 404.',
  })
  @HttpCode(200)
  stop(@Param('id') id: string, @Req() req: { headers: Record<string, unknown>; body: Buffer }) {
    return this.service.stop(id, req.headers, req.body);
  }

  @Post(':id/live/audio')
  @ApiOperation({
    summary: '라이브 PCM 청크 append',
    description:
      '16 kHz mono int16 raw PCM 32768바이트(1.024초)를 이어 붙인다. X-Audio-Offset은 PCM 바이트 '
      + '오프셋(헤더 44바이트 제외). 불일치는 409 + expected_offset이라 ACK가 유실돼도 재동기화된다. '
      + '동시에 하나만 in-flight로 보내야 한다 — HTTP 완료 순서는 전송 순서를 보장하지 않는다.',
  })
  @HttpCode(200)
  append(@Param('id') id: string, @Req() req: { headers: Record<string, unknown>; body: Buffer }) {
    return this.service.appendAudio(id, req.headers, req.body);
  }

  @Get(':id/live')
  @ApiOperation({ summary: '라이브 발화 조회 (seq 커서)' })
  @ApiQuery({ name: 'after', required: false, description: '이 seq 이후 행만' })
  get(@Param('id') id: string, @Query('after') after?: string) {
    return this.service.getLive(id, after);
  }
}
