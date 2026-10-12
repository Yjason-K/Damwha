import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ShareEnabledGuard } from './share-enabled.guard';
import { SharesService } from './shares.service';

/** 상태를 바꾸는 동작은 POST·DELETE뿐이다 — no-cors GET은 Origin 없이 와서 접근 제어를 통과한다(선행 결과 규칙 1). */
@ApiTags('shares')
@UseGuards(ShareEnabledGuard)
@Controller('meetings/:id/share')
export class MeetingShareController {
  constructor(private readonly service: SharesService) {}

  @Get()
  @ApiOperation({ summary: '회의의 현재 공유 (active 또는 철회 대기). 없으면 share: null' })
  get(@Param('id') id: string) { return this.service.get(id); }

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({ summary: '공유될 페이로드 미리보기 (업로드·저장 없음)' })
  preview(@Param('id') id: string, @Body() body: unknown) { return this.service.preview(id, body); }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: '공유 링크 만들기 — 기존 링크는 철회된다' })
  create(@Param('id') id: string, @Body() body: unknown) { return this.service.create(id, body); }

  @Delete()
  @ApiOperation({ summary: '공유 중지 — 서버 삭제가 끝나면 200, 오프라인이면 202(대기)' })
  async stop(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.service.stop(id);
    if (r.pending) res.status(202);
    return { share: r.share };
  }
}

@ApiTags('shares')
@UseGuards(ShareEnabledGuard)
@Controller('shares')
export class SharesController {
  constructor(private readonly service: SharesService) {}

  @Get()
  @ApiOperation({ summary: '공유 중이거나 철회 대기 중인 링크 목록' })
  list() { return this.service.list(); }
}
