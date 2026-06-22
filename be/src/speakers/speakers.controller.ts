import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SpeakersService } from './speakers.service';
import { uploadInterceptorOptions } from '../storage/upload-options';

@Controller('speakers')
export class SpeakersController {
  constructor(private readonly service: SpeakersService) {}

  @Post()
  @UseInterceptors(FileInterceptor('audio', uploadInterceptorOptions))
  enroll(@UploadedFile() file: Express.Multer.File, @Body() body: { name?: string }) {
    return this.service.enroll(file, body);
  }

  @Get()
  list() { return this.service.list(); }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.service.get(id); }
}
