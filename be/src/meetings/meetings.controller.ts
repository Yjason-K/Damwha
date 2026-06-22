import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
}
