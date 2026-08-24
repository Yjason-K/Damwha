import { Module } from '@nestjs/common';
import { SpeakersController } from './speakers.controller';
import { SpeakersService } from './speakers.service';
import { SpeakersRepository } from './speakers.repository';

@Module({
  controllers: [SpeakersController],
  providers: [SpeakersService, SpeakersRepository],
  exports: [SpeakersRepository],
})
export class SpeakersModule {}
