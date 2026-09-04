import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import type { ReadStream } from 'fs';
import { MeetingsService } from './meetings.service';
import { uploadInterceptorOptions } from '../storage/upload-options';
import { SummaryService } from '../summary/summary.service';
import { audioContentType } from '../storage/content-type';

@ApiTags('meetings')
@Controller('meetings')
export class MeetingsController {
  constructor(
    private readonly service: MeetingsService,
    private readonly summary: SummaryService,
  ) {}

  @Post()
  @ApiOperation({ summary: '회의 오디오 업로드 → 처리 작업 큐잉' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['audio'],
      properties: {
        audio: { type: 'string', format: 'binary', description: '오디오 파일' },
        title: { type: 'string', description: '회의 제목 (선택)' },
        recorded_at: {
          type: 'string', format: 'date-time',
          description: '녹음 시각 ISO8601 (선택). 생략하면 업로드 시각으로 기록된다.',
        },
        processing: {
          type: 'string',
          description:
            '이번 작업 한정 처리 설정 오버라이드 (JSON 문자열). preset과 개별 필드 혼합 가능 — ' +
            '개별 필드(whisper_model/devices/language)가 하나라도 있으면 결과 preset은 custom이 된다 ' +
            '(language만 지정해도 custom).',
        },
        speakers: {
          type: 'string',
          description:
            '화자 수 힌트 (JSON 문자열) — {"min":2,"max":5}. 둘 중 하나만 줘도 된다. 정확히 알면 같은 값. ' +
            '화자 분리의 클러스터 수 추정을 이 범위로 제한한다 (과분할/과소분할 억제). 처리 설정 오버라이드와 무관.',
        },
        defer_lens: {
          type: 'string', enum: ['true', 'false'],
          description:
            '"true"면 처리 완료 후 렌즈 추출을 자동으로 걸지 않는다 (기본 "false"). ' +
            '나중에 POST /meetings/:id/lenses/extract로 직접 실행.',
        },
        defer_summary: {
          type: 'string', enum: ['true', 'false'],
          description:
            '"true"면 처리 완료 후 요약 생성을 자동으로 걸지 않는다 (기본 "false"). ' +
            '나중에 POST /meetings/:id/summary/generate로 직접 실행.',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('audio', uploadInterceptorOptions))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: {
      title?: string; recorded_at?: string; processing?: string; speakers?: string;
      defer_lens?: string; defer_summary?: string;
    },
  ) {
    return this.service.upload(file, body);
  }

  @Get()
  @ApiOperation({ summary: '회의 목록' })
  list() { return this.service.list(); }

  @Get(':id')
  @ApiOperation({ summary: '회의 단건 (발화/클러스터 포함)' })
  get(@Param('id') id: string) { return this.service.get(id); }

  @Get(':id/status')
  @ApiOperation({ summary: '처리 상태 조회' })
  status(@Param('id') id: string) { return this.service.getStatus(id); }

  @Post(':id/lenses/extract')
  @ApiOperation({ summary: '회의 렌즈 수동 재추출' })
  @HttpCode(202)
  extract(@Param('id') id: string) { return this.service.extractLenses(id); }

  @Post(':id/lenses/cancel')
  @ApiOperation({
    summary: '렌즈 추출 취소 (운영용)',
    description:
      '현재 processing_version의 진행 중(queued/running) 렌즈 추출 잡과 run을 failed(cancelled)로 닫는다. ' +
      '워커는 heartbeat에서 소유권 상실을 감지해 자신이 띄운 LLM 서버를 내린다. 진행 중인 것이 없으면 409.',
  })
  @HttpCode(200)
  cancelLenses(@Param('id') id: string) { return this.service.cancelLensExtraction(id); }

  @Post(':id/summary/cancel')
  @ApiOperation({
    summary: '대화 요약 취소 (운영용)',
    description:
      '현재 processing_version의 진행 중(queued/running) 요약 잡과 요약 행을 failed(cancelled)로 닫는다. ' +
      '워커는 heartbeat에서 소유권 상실을 감지해 자신이 띄운 LLM 서버를 내린다. 진행 중인 것이 없으면 409.',
  })
  @HttpCode(200)
  cancelSummary(@Param('id') id: string) { return this.summary.cancel(id); }

  @Post(':id/summary/generate')
  @ApiOperation({ summary: '대화 요약 생성/재생성' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        summary_model: {
          type: 'string',
          description:
            '이번 요약 한정 모델 오버라이드. 생략하면 전역 처리 설정의 summary_model을 쓴다. ' +
            '저장되지 않으며, 진행 중인 요약과 모델이 다르면 409.',
        },
      },
    },
  })
  @HttpCode(202)
  generateSummary(@Param('id') id: string, @Body() body: { summary_model?: unknown }) {
    return this.summary.request(id, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: '회의 정보 수정 (제목/녹음 시각)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', nullable: true, description: '회의 제목 (null이면 해제)' },
        recorded_at: {
          type: 'string', format: 'date-time',
          description: '녹음 시각 ISO8601. null은 받지 않는다 — 모든 회의가 기준일시를 갖는다.',
        },
      },
    },
  })
  update(@Param('id') id: string, @Body() body: { title?: string | null; recorded_at?: string | null }) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: '회의 삭제 (연관 데이터 및 저장 파일 정리)' })
  @HttpCode(204)
  remove(@Param('id') id: string) { return this.service.remove(id); }

  @Put(':id/favorite')
  @ApiOperation({ summary: '즐겨찾기 설정' })
  favorite(@Param('id') id: string) { return this.service.setFavorite(id, true); }

  @Delete(':id/favorite')
  @ApiOperation({ summary: '즐겨찾기 해제' })
  unfavorite(@Param('id') id: string) { return this.service.setFavorite(id, false); }

  @Post(':id/cancel')
  @ApiOperation({
    summary: '처리 취소',
    description:
      '현재 process_meeting 잡(queued/running)과 회의를 failed(cancelled)로 닫는다. ' +
      '워커는 다음 stage 경계 또는 heartbeat에서 소유권 상실을 감지해 멈춘다. 진행 중인 것이 없으면 409. ' +
      '취소된 회의는 failed와 같이 reprocess로 다시 돌릴 수 있다.',
  })
  @HttpCode(200)
  cancel(@Param('id') id: string) { return this.service.cancel(id); }

  @Post(':id/reprocess')
  @ApiOperation({ summary: '재처리 (processing_version 증가 후 재큐잉)' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        processing: {
          type: 'object',
          description:
            '이번 재처리 한정 처리 설정 오버라이드 (JSON 객체). preset과 개별 필드 혼합 가능 — ' +
            '개별 필드(whisper_model/devices/language)가 하나라도 있으면 결과 preset은 custom이 된다 ' +
            '(language만 지정해도 custom).',
        },
        speakers: {
          type: 'object',
          description: '화자 수 힌트 {"min":2,"max":5} — 업로드의 speakers와 동일. 이번 재처리에만 적용.',
        },
      },
    },
  })
  @HttpCode(202)
  reprocess(@Param('id') id: string, @Body() body: { processing?: unknown; speakers?: unknown }) {
    return this.service.reprocess(id, body);
  }

  @Post('reindex-missing')
  @ApiOperation({ summary: '미색인 회의 일괄 재색인 (reconciler 백필)' })
  @HttpCode(202)
  reindexMissing() { return this.service.reindexMissing(); }

  @Post(':id/reindex')
  @ApiOperation({ summary: '단건 검색 재색인' })
  @HttpCode(202)
  reindex(@Param('id') id: string) { return this.service.reindex(id); }

  @Get(':id/audio')
  @ApiOperation({ summary: '오디오 스트리밍 (HTTP Range 지원)' })
  @ApiParam({ name: 'id' })
  @ApiProduces('application/octet-stream')
  async audio(
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    const { key, size } = await this.service.getAudioDescriptor(id);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', audioContentType(key));

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (start > end || end >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return this.pipeAudio(this.service.audioStream(key, { start, end }), res);
    }
    res.status(200);
    res.setHeader('Content-Length', String(size));
    return this.pipeAudio(this.service.audioStream(key), res);
  }

  // pipe()는 소스의 error를 목적지로 전달하지 않는다. 리스너가 없으면 스트리밍
  // 도중 파일이 사라졌을 때(워커 재처리의 os.replace 등) unhandled 'error'가
  // uncaughtException으로 올라가 프로세스가 죽는다. 헤더는 이미 나간 뒤라 상태
  // 코드는 못 바꾸고, 소켓을 끊어 클라이언트에 중단을 알리는 게 최선이다.
  // 반대 방향도 함께 건다 — 플레이어의 탐색은 앞선 range 요청을 계속 버리므로,
  // 끊긴 응답의 읽기 스트림을 닫지 않으면 fd가 샌다.
  private pipeAudio(stream: ReadStream, res: Response) {
    stream.on('error', (err) => res.destroy(err));
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  }
}
