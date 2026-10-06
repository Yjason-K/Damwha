import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TagsService } from './tags.service';

@ApiTags('tags')
@Controller()
export class TagsController {
  constructor(private readonly service: TagsService) {}

  @Get('tags')
  @ApiOperation({ summary: '회의에 붙어 있는 태그 목록 (이름순, 회의 수 포함)' })
  list() { return this.service.list(); }

  @Put('meetings/:id/tags')
  @ApiOperation({
    summary: '회의 태그 설정',
    description:
      '회의의 태그를 names로 통째로 바꾼다. 없는 이름은 새로 만들고, 어느 회의에도 붙지 않게 된 ' +
      '태그는 지운다. 이름은 앞뒤 공백을 다듬고 대소문자를 가리지 않고 중복을 합친다.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['names'],
      properties: {
        names: { type: 'array', items: { type: 'string', maxLength: 30 }, maxItems: 20 },
      },
    },
  })
  set(@Param('id') id: string, @Body() body: { names?: unknown }) {
    return this.service.setForMeeting(id, body);
  }
}
