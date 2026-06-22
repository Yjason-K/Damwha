import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { MeetingsService } from './meetings.service';

@Controller('meetings/:id/clusters')
export class ClustersController {
  constructor(private readonly service: MeetingsService) {}

  @Post(':clusterId/resolve')
  @HttpCode(200)
  resolve(
    @Param('id', ParseUUIDPipe) meetingId: string,
    @Param('clusterId', ParseUUIDPipe) clusterId: string,
    @Body() body: { speaker_id?: string; new_name?: string },
  ) {
    return this.service.resolveCluster(meetingId, clusterId, body);
  }
}
