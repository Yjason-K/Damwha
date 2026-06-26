import {
  Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { MeetingsService } from './meetings.service';
import { uploadInterceptorOptions } from '../storage/upload-options';

@Controller('meetings')
export class MeetingsController {
  constructor(private readonly service: MeetingsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('audio', uploadInterceptorOptions))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { title?: string; recorded_at?: string },
  ) {
    return this.service.upload(file, body);
  }

  @Get()
  list() { return this.service.list(); }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.service.get(id); }

  @Get(':id/status')
  status(@Param('id', ParseUUIDPipe) id: string) { return this.service.getStatus(id); }

  @Post(':id/reprocess')
  @HttpCode(202)
  reprocess(@Param('id', ParseUUIDPipe) id: string) { return this.service.reprocess(id); }

  @Post('reindex-missing')
  @HttpCode(202)
  reindexMissing() { return this.service.reindexMissing(); }

  @Post(':id/reindex')
  @HttpCode(202)
  reindex(@Param('id', ParseUUIDPipe) id: string) { return this.service.reindex(id); }

  @Get(':id/audio')
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
