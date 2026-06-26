import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRepository } from './search.repository';
import { EmbedClient } from './embed.client';

@Module({
  controllers: [SearchController],
  providers: [SearchService, SearchRepository, EmbedClient],
})
export class SearchModule {}
