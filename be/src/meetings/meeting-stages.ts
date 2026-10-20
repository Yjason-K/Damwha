export type StageState = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped';
export interface Stages { process: StageState; summary: StageState; lens: StageState }

export interface StageInputs {
  /** meeting.status: recording | uploaded | processing | done | failed */
  meeting_status: string;
  /** 현재 processing_version의 요약 행 status. 행이 없으면 null. */
  summary_status: string | null;
  /** 현재 processing_version의 최신 lens_extraction_run status. 없으면 null. */
  lens_status: string | null;
}

function processStage(status: string): StageState {
  switch (status) {
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'processing': return 'running';
    case 'uploaded': return 'queued';
    default: return 'pending'; // recording — 처리가 시작되지 않았다
  }
}

// 후속 job(요약·렌즈)은 워커가 처리 완료와 같은 트랜잭션에서 만든다. 그래서 처리가 끝났는데
// 행이 없으면 앞으로도 생기지 않는다(꺼졌거나 모델 없음) — skipped. `--wait`가 영영 오지 않을
// 단계를 기다리며 매달리지 않게 하는 구분이다.
function followupStage(rowStatus: string | null, processDone: boolean): StageState {
  if (rowStatus === 'queued' || rowStatus === 'running' || rowStatus === 'done' || rowStatus === 'failed') {
    return rowStatus;
  }
  return processDone ? 'skipped' : 'pending';
}

export function toStages(i: StageInputs): Stages {
  const process = processStage(i.meeting_status);
  const processDone = process === 'done';
  return {
    process,
    summary: followupStage(i.summary_status, processDone),
    lens: followupStage(i.lens_status, processDone),
  };
}
