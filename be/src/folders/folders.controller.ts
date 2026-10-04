import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FoldersService } from './folders.service';

const NAME_BODY = {
  schema: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 30 } },
  },
};

@ApiTags('folders')
@Controller('folders')
export class FoldersController {
  constructor(private readonly service: FoldersService) {}

  @Get()
  @ApiOperation({ summary: '폴더 목록 (기본 폴더 먼저, 나머지는 이름순)' })
  list() { return this.service.list(); }

  @Post()
  @ApiOperation({
    summary: '폴더 만들기',
    description: '이름은 앞뒤 공백을 다듬고 1–30자. 대소문자만 다른 이름이 이미 있으면 409.',
  })
  @ApiBody(NAME_BODY)
  @HttpCode(201)
  create(@Body() body: { name?: unknown }) {
    return this.service.create(body ?? {});
  }

  @Patch(':id')
  @ApiOperation({
    summary: '폴더 이름 바꾸기',
    description: '기본 폴더는 이름을 바꿀 수 없다(400). 없는 폴더는 404, 이름 중복은 409.',
  })
  @ApiBody(NAME_BODY)
  rename(@Param('id') id: string, @Body() body: { name?: unknown }) {
    return this.service.rename(id, body ?? {});
  }

  @Delete(':id')
  @ApiOperation({
    summary: '폴더 삭제',
    description: '안에 있던 회의는 지우지 않고 기본 폴더로 옮긴다. 기본 폴더는 지울 수 없다(400). 없는 폴더는 404.',
  })
  @HttpCode(204)
  remove(@Param('id') id: string) { return this.service.remove(id); }
}
