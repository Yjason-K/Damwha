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
      + '자투리 PCM(0바이트 이상 32768바이트 미만의 짝수) body가 필요하다. 봉인과 마지막 청크를 '
      + '한 요청으로 묶어 그 사이 창을 없앤다. X-Audio-Offset이 DB의 확정 경계(committed_bytes)와 '
      + '같아야 하며, 파일에 크래시가 남긴 미확정 꼬리가 있으면 먼저 잘라낸 뒤 자투리를 쓰고 '
      + '같은 트랜잭션에서 committed=sealed=final로 봉인한다. 경계가 다르면 missing_chunk 409 + '
      + 'expected_offset(그 경계에서 빈 stop으로 재시도하면 된다). 이미 봉인된 job에 같은 '
      + 'X-Final-Offset으로 다시 오면 200 멱등이고 새 process job을 만들지 않는다(live job이 '
      + 'done이면 finalized, 아니면 stopping), 다르면 409. 워커가 아직 claim하지 않은 세션은 '
      + 'API가 직접 마무리한다 — 0바이트면 회의를 지우고 discarded, 그 외는 uploaded로 올리고 '
      + 'process_meeting을 큐잉해 finalized. 이미 워커가 잡고 있으면 stop_requested_at만 찍고 '
      + 'stopping(워커가 마무리한다). recording이 아니면 409, 회의가 없으면 404. '
      + '누적 PCM 4시간 상한(460800000바이트)을 넘기면 상한까지만 쓰고 봉인한 뒤 '
      + "409 {code:'duration_limit'}. 디스크 실패는 507이고 세션을 io_error로 닫는다. "
      + '선택 헤더 X-Capture-Error(device_ended/buffer_overflow/upload_failed/'
      + 'capture_flush_failed)는 브라우저가 '
      + '캡처를 끝까지 못 했다는 뜻이고 meeting.capture_error에 남는다 — 모르는 값도 거절하지 '
      + '않고 capture_failed로 기록한다(진단 헤더가 봉인을 막으면 안 된다).',
  })
  @HttpCode(200)
  stop(@Param('id') id: string, @Req() req: { headers: Record<string, unknown>; body: Buffer }) {
    return this.service.stop(id, req.headers, req.body);
  }

  @Post(':id/live/audio')
  @ApiOperation({
    summary: '라이브 PCM 청크 append',
    description:
      '16 kHz mono int16 raw PCM 32768바이트(1.024초)를 DB의 확정 경계(committed_bytes)에 이어 '
      + '붙인다. X-Audio-Offset은 PCM 바이트 오프셋(헤더 44바이트 제외)이고, 파일 길이가 아니라 '
      + '이 확정 경계와 같아야 한다 — 크래시가 남긴 미확정 꼬리는 쓰기 전에 잘라낸다. 불일치는 '
      + '409 + expected_offset이라 ACK가 유실돼도 재동기화된다. expected_offset이 이 청크의 끝이면 '
      + '중복(서버가 이미 받았다)이고, 시작이면 서버가 아직 못 받은 것이라 같은 청크를 다시 보낸다. '
      + "봉인된 세션은 409 {code:'sealed'}, 4시간 상한(460800000바이트) 초과는 상한까지만 쓰고 "
      + "봉인한 뒤 409 {code:'duration_limit'}이며 둘 다 재전송 대상이 아니다. 디스크 실패는 507이고 "
      + '세션을 io_error로 닫는다. 동시에 하나만 in-flight로 보내야 한다 — HTTP 완료 순서는 전송 '
      + '순서를 보장하지 않는다.',
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
