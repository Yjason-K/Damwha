import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { SpeakersService } from './speakers.service';
import { uploadInterceptorOptions } from '../storage/upload-options';

@ApiTags('speakers')
@Controller('speakers')
export class SpeakersController {
  constructor(private readonly service: SpeakersService) {}

  @Post()
  @ApiOperation({ summary: '화자 등록 (음성 샘플로 voiceprint 생성)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['audio'],
      properties: {
        audio: { type: 'string', format: 'binary', description: '화자 음성 샘플' },
        name: { type: 'string', description: '화자 이름 (선택)' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('audio', uploadInterceptorOptions))
  enroll(@UploadedFile() file: Express.Multer.File, @Body() body: { name?: string }) {
    return this.service.enroll(file, body);
  }

  @Get()
  @ApiOperation({ summary: '화자 목록' })
  list() { return this.service.list(); }

  @Get(':id')
  @ApiOperation({ summary: '화자 단건' })
  get(@Param('id') id: string) { return this.service.get(id); }

  @Patch(':id')
  @ApiOperation({ summary: '화자 이름 변경 (provisional이면 ready로 확정)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '변경할 화자 이름' },
      },
    },
  })
  rename(@Param('id') id: string, @Body() body: { name?: string }) {
    return this.service.rename(id, body);
  }

  @Put(':id/me')
  @ApiOperation({ summary: "화자를 '나'로 지정 (기존 '나'는 해제, 화자 행 반환)" })
  setMe(@Param('id') id: string) { return this.service.setMe(id); }

  @Delete(':id/me')
  @ApiOperation({ summary: "화자의 '나' 지정 해제 (멱등)" })
  @HttpCode(204)
  clearMe(@Param('id') id: string) { return this.service.clearMe(id); }

  @Delete(':id')
  @ApiOperation({ summary: '화자 삭제 (발화/클러스터 참조 해제 후 삭제)' })
  @HttpCode(204)
  remove(@Param('id') id: string) { return this.service.remove(id); }
}
