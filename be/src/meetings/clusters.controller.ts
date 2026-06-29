import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MeetingsService } from './meetings.service';

@ApiTags('clusters')
@Controller('meetings/:id/clusters')
export class ClustersController {
  constructor(private readonly service: MeetingsService) {}

  @Post(':clusterId/resolve')
  @ApiOperation({ summary: '미식별 클러스터를 화자로 연결 (기존 화자 또는 신규 생성)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        speaker_id: { type: 'string', description: '연결할 기존 화자 ID' },
        new_name: { type: 'string', description: '신규 화자 이름 (speaker_id 미지정 시)' },
      },
    },
  })
  @HttpCode(200)
  resolve(
    @Param('id') meetingId: string,
    @Param('clusterId') clusterId: string,
    @Body() body: { speaker_id?: string; new_name?: string },
  ) {
    return this.service.resolveCluster(meetingId, clusterId, body);
  }
}
