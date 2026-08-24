import { Module } from '@nestjs/common';
import { SavedUtterancesController } from './saved-utterances.controller';
import { SavedUtterancesRepository } from './saved-utterances.repository';
import { SavedUtterancesService } from './saved-utterances.service';

@Module({
  controllers: [SavedUtterancesController],
  providers: [SavedUtterancesRepository, SavedUtterancesService],
})
export class SavedUtterancesModule {}
