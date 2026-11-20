import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
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
  ids(@Query('meeting_id') meetingId: unknown) { return this.service.ids(meetingId); }

  @Put(':utteranceId')
  @ApiOperation({ summary: '발언 저장' })
  save(@Param('utteranceId') utteranceId: string, @Body() body: { text_snapshot?: unknown }) { return this.service.save(utteranceId, body); }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: '저장한 발언 해제' })
  @ApiParam({
    name: 'id',
    description: '저장 항목 id(sav_N) 또는 발언 id(utt_N). 원본 발언이 사라진 항목은 sav_N으로만 지울 수 있다. 형식이 맞는데 없으면 204, 형식이 틀리면 404.',
  })
  remove(@Param('id') id: string) { return this.service.remove(id); }
}
