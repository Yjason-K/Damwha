import { Body, Controller, Post } from '@nestjs/common';
import { SearchQuery, SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Post()
  search(@Body() body: SearchQuery) {
    return this.service.search(body ?? {});
  }
}
