import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export type FolderRow = { id: string; name: string; is_default: boolean; created_at: Date };

const COLUMNS = 'id, name, is_default, created_at';

@Injectable()
export class FoldersRepository {
  async list(exec: Queryable): Promise<FolderRow[]> {
    const { rows } = await exec.query<FolderRow>(
      `SELECT ${COLUMNS} FROM folder
       ORDER BY is_default DESC, lower(name) COLLATE "C", length(id), id`,
    );
    return rows;
  }

  async create(exec: Queryable, name: string): Promise<FolderRow> {
    const { rows } = await exec.query<FolderRow>(
      `INSERT INTO folder(name) VALUES($1) RETURNING ${COLUMNS}`,
      [name],
    );
    return rows[0];
  }

  async rename(exec: Queryable, id: string, name: string): Promise<FolderRow | null> {
    const { rows } = await exec.query<FolderRow>(
      `UPDATE folder SET name=$2 WHERE id=$1 RETURNING ${COLUMNS}`,
      [id, name],
    );
    return rows[0] ?? null;
  }

  async findById(exec: Queryable, id: string): Promise<FolderRow | null> {
    const { rows } = await exec.query<FolderRow>(`SELECT ${COLUMNS} FROM folder WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }

  async lockById(exec: Queryable, id: string): Promise<FolderRow | null> {
    const { rows } = await exec.query<FolderRow>(
      `SELECT ${COLUMNS} FROM folder WHERE id=$1 FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findDefault(exec: Queryable): Promise<FolderRow> {
    const { rows } = await exec.query<FolderRow>(`SELECT ${COLUMNS} FROM folder WHERE is_default`);
    return rows[0];
  }

  async moveMeetingsToDefault(exec: Queryable, id: string): Promise<number> {
    const res = await exec.query(
      `UPDATE meeting SET folder_id = default_folder_id() WHERE folder_id = $1`,
      [id],
    );
    return res.rowCount ?? 0;
  }

  async delete(exec: Queryable, id: string): Promise<boolean> {
    const res = await exec.query(`DELETE FROM folder WHERE id=$1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async exists(exec: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await exec.query(`SELECT 1 FROM folder WHERE id=$1`, [id]);
    return rowCount === 1;
  }
}
