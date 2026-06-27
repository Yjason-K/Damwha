import {
  Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { MeetingsService } from './meetings.service';
import { uploadInterceptorOptions } from '../storage/upload-options';

@ApiTags('meetings')
@Controller('meetings')
export class MeetingsController {
  constructor(private readonly service: MeetingsService) {}

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
      },
    },
  })
  @UseInterceptors(FileInterceptor('audio', uploadInterceptorOptions))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { title?: string; recorded_at?: string },
  ) {
    return this.service.upload(file, body);
  }

  @Get()
  @ApiOperation({ summary: '회의 목록' })
  list() { return this.service.list(); }

  @Get(':id')
  @ApiOperation({ summary: '회의 단건 (발화/클러스터 포함)' })
  get(@Param('id', ParseUUIDPipe) id: string) { return this.service.get(id); }

  @Get(':id/status')
  @ApiOperation({ summary: '처리 상태 조회' })
  status(@Param('id', ParseUUIDPipe) id: string) { return this.service.getStatus(id); }

  @Post(':id/reprocess')
  @ApiOperation({ summary: '재처리 (processing_version 증가 후 재큐잉)' })
  @HttpCode(202)
  reprocess(@Param('id', ParseUUIDPipe) id: string) { return this.service.reprocess(id); }

  @Post('reindex-missing')
  @ApiOperation({ summary: '미색인 회의 일괄 재색인 (reconciler 백필)' })
  @HttpCode(202)
  reindexMissing() { return this.service.reindexMissing(); }

  @Post(':id/reindex')
  @ApiOperation({ summary: '단건 검색 재색인' })
  @HttpCode(202)
  reindex(@Param('id', ParseUUIDPipe) id: string) { return this.service.reindex(id); }

  @Get(':id/audio')
  @ApiOperation({ summary: '오디오 스트리밍 (HTTP Range 지원)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('application/octet-stream')
  async audio(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    const { key, size } = await this.service.getAudioDescriptor(id);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');

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
