import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
}
