import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseService } from '../database/database.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @ApiOperation({ summary: '헬스체크 — DB에 실제 쿼리를 던져 본다' })
  @ApiResponse({ status: 200, description: '{ status: "ok", db: "ok" }' })
  @ApiResponse({ status: 503, description: '{ status: "error", db: "unreachable" }' })
  async check() {
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'unreachable' });
    }
    return { status: 'ok', db: 'ok' };
  }
}
