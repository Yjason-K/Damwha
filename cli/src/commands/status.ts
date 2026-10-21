import type { ConnectionResult } from '../connection';
import type { RunIo } from '../context';
import { msg, type Lang } from '../messages';
import { printJson, printLine } from '../output';
import type { DamwhaClient } from '../client';

/** 앱 연결 상태 진단. 연결되면 0, 아니면 2. 모델 상태는 연결 판정과 별개로 보여주기만 한다 (spec §2.5). */
export async function status(
  io: RunIo,
  lang: Lang,
  conn: ConnectionResult,
  client: DamwhaClient | null,
  json: boolean,
): Promise<number> {
  if (conn.kind !== 'ok') {
    const text = msg(lang, conn.kind === 'starting' ? 'starting' : 'notRunning');
    if (json) printJson(io.stdout, { connected: false, state: conn.kind });
    else printLine(io.stderr, text);
    return 2;
  }
  let models: unknown = null;
  try {
    models = (await client!.listModels()).models;
  } catch {
    // 모델 조회 실패는 연결 진단을 깨지 않는다.
  }
  if (json) printJson(io.stdout, { connected: true, api: conn.baseUrl, models });
  else {
    printLine(io.stdout, `connected: ${conn.baseUrl}`);
    if (Array.isArray(models)) {
      for (const m of models as { role: string; name: string; installed: string }[]) {
        printLine(io.stdout, `${m.role}  ${m.name}  ${m.installed}`);
      }
    }
  }
  return 0;
}
