import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { FolderRow, FoldersRepository } from './folders.repository';
import { FOLDER_ID_RE } from './folder-id';

const MAX_NAME_LENGTH = 30;

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('name must be a string');
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new BadRequestException(`folder name must be 1-${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

function isDuplicateName(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === '23505';
}

@Injectable()
export class FoldersService {
  constructor(private readonly db: DatabaseService, private readonly repo: FoldersRepository) {}

  list() {
    return this.repo.list(this.db.pool);
  }

  async create(body: { name?: unknown }): Promise<FolderRow> {
    const name = parseName(body?.name);
    try {
      return await this.repo.create(this.db.pool, name);
    } catch (e) {
      if (isDuplicateName(e)) throw new ConflictException('folder name already exists');
      throw e;
    }
  }

  async rename(id: string, body: { name?: unknown }): Promise<FolderRow> {
    if (!FOLDER_ID_RE.test(id)) throw new NotFoundException('folder not found');
    const name = parseName(body?.name);
    const folder = await this.repo.findById(this.db.pool, id);
    if (!folder) throw new NotFoundException('folder not found');
    if (folder.is_default) throw new BadRequestException('default folder cannot be renamed');
    let renamed: FolderRow | null;
    try {
      renamed = await this.repo.rename(this.db.pool, id, name);
    } catch (e) {
      if (isDuplicateName(e)) throw new ConflictException('folder name already exists');
      throw e;
    }
    if (!renamed) throw new NotFoundException('folder not found');
    return renamed;
  }

  // 회의를 기본 폴더로 옮긴 뒤 지운다. FK에 ON DELETE가 없으므로 옮기는 단계를 빠뜨리면
  // DELETE가 거부된다 — 회의가 폴더와 함께 사라지는 일은 DB 단에서 막힌다.
  async remove(id: string): Promise<void> {
    if (!FOLDER_ID_RE.test(id)) throw new NotFoundException('folder not found');
    await this.db.withTransaction(async (c) => {
      const folder = await this.repo.lockById(c, id);
      if (!folder) throw new NotFoundException('folder not found');
      if (folder.is_default) throw new BadRequestException('default folder cannot be deleted');
      await this.repo.moveMeetingsToDefault(c, id);
      await this.repo.delete(c, id);
    });
  }
}
