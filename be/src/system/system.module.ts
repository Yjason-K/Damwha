import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { CAPABILITIES, detectCapabilities } from './capabilities';

@Module({
  controllers: [SystemController],
  providers: [{ provide: CAPABILITIES, useFactory: detectCapabilities }],
  exports: [CAPABILITIES],
})
export class SystemModule {}
