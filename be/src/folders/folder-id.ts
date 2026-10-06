import { BadRequestException } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';
import { FoldersRepository } from './folders.repository';

export const FOLDER_ID_RE = /^fld_[1-9][0-9]*$/;

/**
 * 회의 요청 본문의 folder_id. 생략과 ''는 "미지정"이다 — INSERT의 COALESCE가 기본 폴더로
 * 채운다(recorded_at과 같은 규칙). multipart 필드는 비워도 ''로 도착한다.
 */
export function parseFolderId(v: unknown): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !FOLDER_ID_RE.test(v)) {
    throw new BadRequestException('folder_id must be a folder id');
  }
  return v;
}

/** 본문이 가리키는 폴더라 없으면 404가 아니라 400이다. */
export async function assertFolderExists(
  folders: FoldersRepository, exec: Queryable, id: string,
): Promise<void> {
  if (!(await folders.exists(exec, id))) throw new BadRequestException('folder not found');
}
