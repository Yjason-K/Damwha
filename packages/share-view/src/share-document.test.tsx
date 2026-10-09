import { render, screen, within } from '@testing-library/react';
import type { SharePayloadV1 } from '@damwha/share-format';
import { ShareDocument } from './share-document';

const full = (): SharePayloadV1 => ({
  v: 1,
  created_at: '2026-10-09T00:00:00.000Z',
  ui_language: 'ko',
  meeting: { title: '주간 회의', recorded_at: '2026-10-08T01:00:00.000Z', duration_ms: 3_725_000 },
  speakers: [{ ref: 's1', name: '김담화' }, { ref: 's2', name: null }],
  summary: { topics: ['배포 일정'], segments: [{ title: '배포 논의', bullets: ['화요일 배포'], start_ms: 65_000, end_ms: 120_000 }] },
  lenses: [
    { kind: 'decision', text: '화요일에 배포한다', done: false, due_at: null, assignee_ref: null, start_ms: 65_000, linkable: true },
    { kind: 'action', text: '릴리스 노트', done: true, due_at: '2026-10-14', assignee_ref: 's1', start_ms: 70_000, linkable: false },
  ],
  transcript: [
    { speaker_ref: 's1', start_ms: 65_000, end_ms: 69_000, text: '화요일에 하죠' },
    { speaker_ref: 's2', start_ms: 70_000, end_ms: 72_000, text: '좋아요' },
  ],
  note: { body_md: '본문\n<img src=x onerror="alert(1)">\n[링크](javascript:alert(1)) [안전](https://example.com)\n![추적](https://tracker.example/p.png)' },
});

it('모든 섹션을 그린다', () => {
  render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  expect(screen.getByRole('heading', { level: 1, name: '주간 회의' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '요약' })).toBeInTheDocument();
  expect(screen.getByText('배포 일정')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '결정' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '할 일' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '발화 기록' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '메모' })).toBeInTheDocument();
});

it('없는 섹션은 제목도 그리지 않는다', () => {
  const { summary, lenses, transcript, note, ...bare } = full();
  render(<ShareDocument payload={bare} lang="ko" expiresAt={null} />);
  for (const name of ['요약', '결정', '할 일', '약속', '발화 기록', '메모']) {
    expect(screen.queryByRole('heading', { name })).toBeNull();
  }
});

it('렌즈 0개·요약 세그먼트 0개도 빈 제목을 남기지 않는다', () => {
  render(<ShareDocument payload={{ ...full(), lenses: [], summary: { topics: [], segments: [] }, transcript: [] }} lang="ko" expiresAt={null} />);
  expect(screen.queryByRole('heading', { name: '결정' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '요약' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '발화 기록' })).toBeNull();
});

it('이름이 없는 화자는 "화자 N"으로 — N은 ref 번호다', () => {
  render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  const transcript = screen.getByRole('region', { name: '발화 기록' });
  expect(within(transcript).getByText('김담화')).toBeInTheDocument();
  expect(within(transcript).getByText('화자 2')).toBeInTheDocument();
});

it('메모의 raw HTML과 javascript: 링크는 살아나지 않는다', () => {
  const { container } = render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  expect(container.querySelector('img')).toBeNull();
  const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  expect(links).toEqual(['https://example.com']);
  expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
});

it('linkable이고 발화 기록이 있을 때만 시각이 버튼이다', () => {
  render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  const decisions = screen.getByRole('region', { name: '결정' });
  expect(within(decisions).getByRole('button', { name: /1:05/ })).toBeInTheDocument();
  const actions = screen.getByRole('region', { name: '할 일' });
  expect(within(actions).queryByRole('button')).toBeNull();
  expect(within(actions).getByText('1:10')).toBeInTheDocument();
});

it('발화 기록이 없으면 linkable이어도 시각은 글자다', () => {
  const { transcript, ...p } = full();
  render(<ShareDocument payload={p} lang="ko" expiresAt={null} />);
  expect(within(screen.getByRole('region', { name: '결정' })).queryByRole('button')).toBeNull();
});

it('영어 문구', () => {
  render(<ShareDocument payload={full()} lang="en" expiresAt="2026-10-16T00:00:00.000Z" />);
  expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Transcript' })).toBeInTheDocument();
  expect(screen.getByText('Speaker 2')).toBeInTheDocument();
});

it('만료 시각이 있으면 하단에 표시, 없으면 만료 문구를 빼고 스냅샷 안내만', () => {
  const { unmount } = render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  expect(screen.getByText(/링크 만료/)).toBeInTheDocument();
  unmount();
  render(<ShareDocument payload={full()} lang="ko" expiresAt={null} />);
  expect(screen.queryByText(/링크 만료/)).toBeNull();
  expect(screen.getByText(/담화로 만든 공유본/)).toBeInTheDocument();
});

it('제목이 없으면 대체 제목, 하단에 스냅샷 안내', () => {
  render(<ShareDocument payload={{ ...full(), meeting: { ...full().meeting, title: null } }} lang="ko" expiresAt={null} />);
  expect(screen.getByRole('heading', { level: 1, name: '제목 없는 대화' })).toBeInTheDocument();
  expect(screen.getByText('보낸 사람이 공유한 시점의 내용이에요.')).toBeInTheDocument();
});
