import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ModelsService } from './models.service';

@ApiTags('models')
@Controller('models')
export class ModelsController {
  constructor(private readonly service: ModelsService) {}

  @Get()
  @ApiOperation({ summary: '모델별 사용 여부·받음 여부·용량 (읽기 전용)' })
  list() {
    return this.service.list();
  }

  @Post('download')
  @ApiOperation({ summary: '모델 미리 받기 — download_model job을 넣는다 (같은 job이 있으면 그것)' })
  async download(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.service.download(body);
    res.status(r.created ? 201 : 200);
    return { job: r.job };
  }

  @Post('delete')
  @ApiOperation({ summary: '모델 삭제 — delete_model job. 쓰는 모델은 409' })
  async remove(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.service.delete(body);
    res.status(r.created ? 201 : 200);
    return { job: r.job };
  }

  @Post('cancel')
  @HttpCode(200)
  @ApiOperation({ summary: '받기 취소 — queued는 바로 닫고, running은 worker에게 멈추라고 알린다' })
  cancel(@Body() body: unknown) {
    return this.service.cancel(body);
  }
}
