import type { UiLanguage } from '@damwha/contracts';

const ko = {
  untitled: '제목 없는 대화',
  summary: '요약',
  topics: '주요 주제',
  decision: '결정',
  action: '할 일',
  promise: '약속',
  transcript: '발화 기록',
  note: '메모',
  speaker: (n: number) => `화자 ${n}`,
  due: (d: string) => `기한 ${d}`,
  done: '완료',
  jumpTo: (t: string) => `${t} 발화로 이동`,
  madeWith: '담화로 만든 공유본',
  expires: (d: string) => `링크 만료 ${d}`,
  snapshot: '보낸 사람이 공유한 시점의 내용이에요.',
};

export type ViewerStrings = typeof ko;

const en: ViewerStrings = {
  untitled: 'Untitled conversation',
  summary: 'Summary',
  topics: 'Topics',
  decision: 'Decisions',
  action: 'Action items',
  promise: 'Promises',
  transcript: 'Transcript',
  note: 'Notes',
  speaker: (n) => `Speaker ${n}`,
  due: (d) => `Due ${d}`,
  done: 'Done',
  jumpTo: (t) => `Jump to ${t}`,
  madeWith: 'Shared from Damwha',
  expires: (d) => `Link expires ${d}`,
  snapshot: 'This is a snapshot from when it was shared.',
};

export function viewerStrings(lang: UiLanguage): ViewerStrings {
  return lang === 'ko' ? ko : en;
}
