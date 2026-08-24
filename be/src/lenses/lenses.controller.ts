import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LensesService } from './lenses.service';
import { LensCompletionStatus, EvidenceRelation } from './lens.types';

@ApiTags('lenses')
@Controller()
export class LensesController {
  constructor(private readonly service: LensesService) {}

  @Get('lenses')
  @ApiOperation({ summary: '렌즈 항목 목록 (필터 + keyset 커서 페이지네이션)' })
  list(@Query() query: Record<string, string | undefined>) {
    return this.service.list(query);
  }

  @Get('meetings/:id/lenses')
  @ApiOperation({
    summary: '회의의 활성 렌즈 항목 목록 + 현재 버전의 추출 상태',
    description:
      'extraction_status는 이 회의의 현재 processing_version에서 마지막 추출 run의 상태다. ' +
      'null이면 그 버전에서 추출을 돌린 적이 없다는 뜻(업로드에서 defer_lens로 미뤘거나 ' +
      '워커에 렌즈 모델이 없음)이고, 항목 0건이 "추출했는데 없음"인지 "아직 안 함"인지를 가른다.',
  })
  listForMeeting(@Param('id') id: string) {
    return this.service.listForMeeting(id);
  }

  @Get('lenses/extraction-status')
  @ApiOperation({ summary: '전역 렌즈 추출 상태 집계 (진행중 수 + 실패 회의)' })
  extractionStatus() {
    return this.service.extractionStatus();
  }

  @Post('lenses')
  @ApiOperation({ summary: '렌즈 항목 수동 생성 (source=user)' })
  create(@Body() body: { meeting_id?: string; kind?: string; text?: string; assignee_speaker_id?: string; due_at?: string }) {
    return this.service.create(body);
  }

  @Patch('lenses/:id')
  @ApiOperation({ summary: '렌즈 항목 수정 (source=edited)' })
  update(@Param('id') id: string, @Body() body: { text?: string; kind?: string; assignee_speaker_id?: string | null; due_at?: string | null }) {
    return this.service.update(id, body);
  }

  @Post('lenses/:id/complete')
  @ApiOperation({ summary: '렌즈 항목 완료 처리' })
  complete(@Param('id') id: string) {
    return this.service.setCompletion(id, 'done' as LensCompletionStatus);
  }

  @Post('lenses/:id/reopen')
  @ApiOperation({ summary: '렌즈 항목 완료 해제' })
  reopen(@Param('id') id: string) {
    return this.service.setCompletion(id, 'open' as LensCompletionStatus);
  }

  @Delete('lenses/:id')
  @ApiOperation({ summary: '렌즈 항목 삭제' })
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post('lenses/:id/evidence')
  @ApiOperation({ summary: '근거 발화 추가' })
  addEvidence(@Param('id') id: string, @Body() body: { utterance_id?: string; relation?: EvidenceRelation }) {
    return this.service.addEvidence(id, body);
  }

  @Delete('lenses/:id/evidence/:utteranceId')
  @ApiOperation({ summary: '근거 발화 제거' })
  removeEvidence(@Param('id') id: string, @Param('utteranceId') utteranceId: string) {
    return this.service.removeEvidence(id, utteranceId);
  }
}
