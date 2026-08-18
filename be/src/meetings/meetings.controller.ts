import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
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
        recorded_at: { type: 'string', format: 'date-time', description: '녹음 시각 ISO8601 (선택)' },
        processing: {
          type: 'string',
          description:
            '이번 작업 한정 처리 설정 오버라이드 (JSON 문자열). preset과 개별 필드 혼합 가능 — ' +
            '개별 필드(whisper_model/devices/language)가 하나라도 있으면 결과 preset은 custom이 된다 ' +
            '(language만 지정해도 custom).',
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
      title?: string; recorded_at?: string; processing?: string;
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
          type: 'string', format: 'date-time', nullable: true,
          description: '녹음 시각 ISO8601 (null이면 해제)',
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
      },
    },
  })
  @HttpCode(202)
  reprocess(@Param('id') id: string, @Body() body: { processing?: unknown }) {
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
      return this.service.audioStream(key, { start, end }).pipe(res);
    }
    res.status(200);
    res.setHeader('Content-Length', String(size));
    return this.service.audioStream(key).pipe(res);
  }
}
