import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SavedUtterancesService } from './saved-utterances.service';

@ApiTags('saved-utterances')
@Controller('saved-utterances')
export class SavedUtterancesController {
  constructor(private readonly service: SavedUtterancesService) {}

  @Get()
  @ApiOperation({ summary: '저장한 발언 목록' })
  list(@Query() query: Record<string, string | undefined>) { return this.service.list(query); }

  @Get('ids')
  @ApiOperation({ summary: '발언 저장 여부 조회' })
  ids(@Query('utterance_ids') ids: string | undefined) { return this.service.ids(ids); }

  @Put(':utteranceId')
  @ApiOperation({ summary: '발언 저장' })
  save(@Param('utteranceId') utteranceId: string, @Body() body: { text_snapshot?: unknown }) { return this.service.save(utteranceId, body); }

  @Delete(':utteranceId')
  @HttpCode(204)
  @ApiOperation({ summary: '저장한 발언 해제' })
  remove(@Param('utteranceId') utteranceId: string) { return this.service.remove(utteranceId); }
}
