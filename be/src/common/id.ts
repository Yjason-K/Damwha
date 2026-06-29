import { Pool, PoolClient } from 'pg';

export type Queryable = Pool | PoolClient;

const SEQ = { meeting: 'mtg', speaker: 'spk' } as const;

/**
 * 시퀀스에서 사람이 읽기 쉬운 엔티티 id를 채번한다.
 * meeting/speaker는 파일 저장 전 id가 필요하므로 트랜잭션 밖(pool)에서 선할당한다.
 * prefix는 리터럴 맵에서만 오므로 SQL 인젝션 위험 없음.
 */
export async function nextId(q: Queryable, t: keyof typeof SEQ): Promise<string> {
  const p = SEQ[t];
  const { rows } = await q.query<{ id: string }>(`SELECT '${p}_' || nextval('${p}_id_seq') AS id`);
  return rows[0].id;
}
