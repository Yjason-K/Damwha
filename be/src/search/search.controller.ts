import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SearchQuery, SearchService } from './search.service';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Post()
  @ApiOperation({
    summary: '발화 검색 (하이브리드/키워드/browse)',
    description: 'q 있으면 임베드 성공 시 hybrid, 실패 시 keyword. q 비면 browse(최신순).',
  })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '검색어 (비우면 browse)' },
        limit: { type: 'number', description: '결과 수 (1–100, 기본 20)' },
        filters: {
          type: 'object',
          properties: {
            dateFrom: { type: 'string', format: 'date-time' },
            dateTo: { type: 'string', format: 'date-time' },
            speakerIds: { type: 'array', items: { type: 'string' } },
            meetingIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  })
  search(@Body() body: SearchQuery) {
    return this.service.search(body ?? {});
  }
}
