import { Module } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import { loadEnv } from '../config/env';
import { isExecutableFile } from './find-executable';
import { INTEGRATIONS_ENABLED, IntegrationsEnabledGuard } from './integrations-enabled.guard';
import { integrationsEnabled } from './integrations-enabled';
import { IntegrationsController } from './integrations.controller';
import { INTEGRATIONS_DEPS, IntegrationsService, type IntegrationsDeps } from './integrations.service';
import { runCommand } from './run-command';

@Module({
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    IntegrationsEnabledGuard,
    { provide: INTEGRATIONS_ENABLED, useFactory: () => integrationsEnabled(loadEnv()) },
    {
      provide: INTEGRATIONS_DEPS,
      useFactory: (): IntegrationsDeps => ({
        launcher: loadEnv().DAMWHA_CLI_LAUNCHER ?? '',
        home: os.homedir(),
        shell: process.env.SHELL,
        pathEnv: process.env.PATH ?? '',
        fs: fsp,
        run: runCommand,
        isExecutable: isExecutableFile,
      }),
    },
  ],
})
export class IntegrationsModule {}
