import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { LiveAudioService } from './live-audio.service';

@Global()
@Module({
  providers: [StorageService, LiveAudioService],
  exports: [StorageService, LiveAudioService],
})
export class StorageModule {}
