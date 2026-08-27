import { Body, Controller, Get, Param, Put, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { NotesService } from './notes.service';

@ApiTags('notes')
@Controller('meetings/:id/note')
export class NotesController {
  constructor(private readonly service: NotesService) {}

  @Get()
  @ApiOperation({ summary: '회의 메모 조회 (없으면 note: null)' })
  get(@Param('id') id: string) { return this.service.get(id); }

  @Put()
  @ApiOperation({ summary: '회의 메모 저장 (공백 본문이면 삭제 후 204)' })
  async put(
    @Param('id') id: string,
    @Body() body: { body_md?: unknown },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.put(id, body);
    if (result === null) { res.status(204); return; }
    return result;
  }
}
