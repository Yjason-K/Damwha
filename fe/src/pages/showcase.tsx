import * as React from "react";

import { Avatar } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Checkbox } from "@/shared/ui/checkbox";
import { IconButton } from "@/shared/ui/icon-button";
import { Input } from "@/shared/ui/input";
import { Kbd } from "@/shared/ui/kbd";
import { SearchField } from "@/shared/ui/search-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import { Tag } from "@/shared/ui/tag";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { Toaster } from "@/shared/ui/toaster";
import { toast } from "@/shared/ui/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { SidebarItem } from "@/shared/ui/sidebar-item";
import { Utterance } from "@/shared/ui/utterance";
import { SpeakerTrack } from "@/shared/ui/speaker-track";
import { LensItem } from "@/shared/ui/lens-item";
import { CommandBar, type CommandGroup } from "@/shared/ui/command-bar";
import { NoteEditor } from "@/features/meeting/ui/note-editor";

function Plus() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function Gear() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path
        d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 7L8 2.5 13.5 7M4 6v7.5h8V6" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="1.5" width="4" height="8" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 009 0M8 12v2.5" />
    </svg>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-h3 font-semibold tracking-[-0.008em] text-[color:var(--text-muted)]">
        {title}
      </h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

/** 메모 편집기 데모용 한 칸 — 레일 실제 폭에 맞춰 액자에 넣는다. */
function NoteFrame({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-[var(--rail-insight)] flex-col gap-1.5">
      <span className="text-2xs text-[color:var(--text-faint)]">{label}</span>
      <div className="overflow-hidden rounded-md border border-border bg-[var(--surface-panel)]">
        {children}
      </div>
    </div>
  );
}

// 마크다운 렌더러가 실제로 다루는 것들을 한 번에 보여 준다 — 제목·목록·
// 체크박스·표·인라인/블록 코드·링크, 그리고 메모에서 이미지가 비활성으로
// 처리되는 것까지.
const SAMPLE_NOTE = `## 결정사항

- [x] 배포 브랜치는 \`dev\`로 통일
- [ ] 스키마 v6는 다음 스프린트로

주간 회의에서 나온 내용. 자세한 건 [설계 문서](https://example.com)에.

| 항목 | 담당 | 기한 |
| --- | --- | --- |
| 마이그레이션 | 지훈 | 화요일 |
| 릴리스 노트 | 서연 | 목요일 |

\`\`\`ts
await repo.upsert(pool, meetingId, bodyMd);
\`\`\`

![아키텍처 다이어그램](https://example.com/diagram.png)
`;

const SPEAKERS = [
  { n: 1, name: "김지훈" },
  { n: 2, name: "이서연" },
  { n: 3, name: "박도윤" },
  { n: 4, name: "최하은" },
  { n: 5, name: "정우진" },
  { n: 6, name: "강민서" },
  { n: 7, name: "조예준" },
  { n: 8, name: "윤서아" },
];

export function ShowcasePage() {
  const [removed, setRemoved] = React.useState<number[]>([]);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdQuery, setCmdQuery] = React.useState("");
  const [head, setHead] = React.useState(0.42);
  const [done1, setDone1] = React.useState(true);
  const [done2, setDone2] = React.useState(false);
  const [note, setNote] = React.useState(SAMPLE_NOTE);
  const [emptyNote, setEmptyNote] = React.useState("");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const cmdGroups: CommandGroup[] = [
    {
      label: "회의",
      items: [
        {
          id: "m1",
          icon: <MicIcon />,
          title: "주간 동기화",
          meta: "오늘 14:00 · 8명",
          trail: "⏎",
        },
        {
          id: "m2",
          icon: <MicIcon />,
          title: "스프린트 리뷰",
          meta: "어제 · 6명",
        },
      ],
    },
    {
      label: "바로가기",
      items: [
        { id: "s1", icon: <HomeIcon />, title: "대시보드로 이동" },
        { id: "s2", icon: <Gear />, title: "설정 열기", trail: "⌘," },
      ],
    },
  ];
  const cmdFiltered = cmdQuery.trim()
    ? cmdGroups
        .map((g) => ({
          ...g,
          items: g.items.filter((it) =>
            String(it.title).includes(cmdQuery.trim()),
          ),
        }))
        .filter((g) => g.items.length > 0)
    : cmdGroups;

  return (
    <main className="min-h-screen bg-background px-8 py-10 text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-display font-bold">Damwha Design System</h1>
          <p className="text-base text-[color:var(--text-muted)]">
            Timbre · core + forms 컴포넌트 쇼케이스
          </p>
        </header>

        <Section title="Button">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button iconLeft={<Plus />}>아이콘</Button>
          <Button loading>로딩중</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">sm</Button>
          <Button size="lg">lg</Button>
        </Section>

        <Section title="IconButton">
          <IconButton label="추가" size="sm">
            <Plus />
          </IconButton>
          <IconButton label="추가">
            <Plus />
          </IconButton>
          <IconButton label="설정" size="lg">
            <Gear />
          </IconButton>
          <IconButton label="설정" variant="outline">
            <Gear />
          </IconButton>
          <IconButton label="고정" pressed>
            <Gear />
          </IconButton>
          <IconButton label="비활성" disabled>
            <Gear />
          </IconButton>
        </Section>

        <Section title="Badge">
          <Badge>neutral</Badge>
          <Badge variant="accent">accent</Badge>
          <Badge variant="success" dot>
            success
          </Badge>
          <Badge variant="warning" dot>
            warning
          </Badge>
          <Badge variant="danger" dot>
            danger
          </Badge>
          <Badge variant="outline">outline</Badge>
        </Section>

        <Section title="Tag (speaker chips)">
          {SPEAKERS.slice(0, 5)
            .filter((s) => !removed.includes(s.n))
            .map((s) => (
              <Tag
                key={s.n}
                speaker={s.n}
                onRemove={() => setRemoved((r) => [...r, s.n])}
              >
                {s.name}
              </Tag>
            ))}
          <Tag speaker={6} onClick={() => {}}>
            클릭 가능
          </Tag>
        </Section>

        <Section title="Avatar">
          <Avatar name="김담화" />
          <Avatar name="Jane Doe" />
          <Avatar name="미정" unconfirmed />
          {SPEAKERS.map((s) => (
            <Avatar key={s.n} name={s.name} speaker={s.n} />
          ))}
          <Avatar name="작게" speaker={1} size="xs" />
          <Avatar name="크게" speaker={2} size="xl" />
        </Section>

        <Section title="Kbd">
          <Kbd>⌘</Kbd>
          <Kbd>Esc</Kbd>
          <Kbd keys={["⌘", "K"]} />
          <Kbd keys={["⇧", "⌘", "P"]} size="lg" />
        </Section>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <Card title="기본 카드" subtitle="padding md · raised">
            <p className="text-sm text-[color:var(--text-secondary)]">
              카드 본문 텍스트입니다. 토큰 기반 표면/보더를 사용합니다.
            </p>
          </Card>
          <Card
            title="액션 카드"
            action={
              <Button size="sm" variant="ghost">
                더보기
              </Button>
            }
            raised
          >
            <p className="text-sm text-[color:var(--text-secondary)]">
              헤더에 액션 버튼이 있는 카드.
            </p>
          </Card>
          <Card title="인터랙티브" subtitle="클릭/포커스 가능" interactive>
            <p className="text-sm text-[color:var(--text-secondary)]">
              Tab으로 포커스 → Enter/Space로 활성화.
            </p>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Section title="Input">
            <div className="flex w-full flex-col gap-4">
              <Input
                label="이메일"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
              />
              <Input
                label="검색"
                placeholder="필터…"
                iconLeft={<Plus />}
                trailing={<Kbd>⌘K</Kbd>}
              />
              <Input
                label="비밀번호"
                type="password"
                error="8자 이상 입력하세요."
                defaultValue="123"
              />
              <Input label="비활성" placeholder="disabled" disabled />
            </div>
          </Section>

          <Section title="SearchField · Select">
            <div className="flex w-full flex-col gap-4">
              <SearchField />
              <SearchField asButton shortcut={<Kbd>⌘K</Kbd>} />
              <Select>
                <SelectTrigger aria-label="회의 선택">
                  <SelectValue placeholder="회의 선택…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="전체">전체</SelectItem>
                  <SelectItem value="주간회의">주간회의</SelectItem>
                  <SelectItem value="스프린트 리뷰">스프린트 리뷰</SelectItem>
                </SelectContent>
              </Select>
              <Select defaultValue="b">
                <SelectTrigger size="sm" aria-label="옵션 선택">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="a">옵션 A</SelectItem>
                  <SelectItem value="b">옵션 B</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Section>
        </div>

        <Section title="Checkbox · Switch">
          <div className="flex flex-col gap-3">
            <Checkbox label="기본" />
            <Checkbox label="선택됨" defaultChecked />
            <Checkbox label="부분 선택" indeterminate />
            <Checkbox label="비활성" disabled />
          </div>
          <div className="flex flex-col gap-3">
            <Switch label="알림 끄기" />
            <Switch label="알림 켜기" defaultChecked />
            <Switch label="비활성" disabled />
          </div>
        </Section>

        <Section title="Feedback (Dialog · Tooltip · Toast)">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">다이얼로그 열기</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>회의를 삭제할까요?</DialogTitle>
                <DialogDescription>
                  이 작업은 되돌릴 수 없습니다. 회의록과 인사이트가 영구
                  삭제됩니다.
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm text-[color:var(--text-secondary)]">
                삭제 전 내보내기를 권장합니다.
              </p>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost">취소</Button>
                </DialogClose>
                <Button variant="danger">삭제</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary">호버 / 포커스</Button>
            </TooltipTrigger>
            <TooltipContent>
              명령 팔레트 열기
              <span className="font-mono text-2xs text-[color:var(--gray-7)]">
                ⌘K
              </span>
            </TooltipContent>
          </Tooltip>

          <Button
            onClick={() =>
              toast({
                title: "저장되었습니다",
                description: "변경사항이 반영되었습니다.",
                variant: "success",
              })
            }
          >
            성공 토스트
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast({
                title: "업로드 실패",
                description: "네트워크를 확인해주세요.",
                variant: "error",
                action: { label: "재시도", onClick: () => {} },
              })
            }
          >
            에러 토스트
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              toast({ title: "새 회의가 시작되었습니다", variant: "info" })
            }
          >
            정보 토스트
          </Button>
        </Section>

        <Section title="Navigation (Tabs · SidebarItem)">
          <div className="flex w-full flex-col gap-6">
            <Tabs defaultValue="transcript">
              <TabsList>
                <TabsTrigger value="transcript">전문</TabsTrigger>
                <TabsTrigger value="summary">
                  요약
                  <span className="rounded-xs bg-[var(--gray-3)] px-[5px] py-px font-mono text-2xs text-[color:var(--text-faint)]">
                    3
                  </span>
                </TabsTrigger>
                <TabsTrigger value="actions">액션 아이템</TabsTrigger>
              </TabsList>
              <TabsContent value="transcript">전문 탭 내용입니다.</TabsContent>
              <TabsContent value="summary">요약 탭 내용입니다.</TabsContent>
              <TabsContent value="actions">
                액션 아이템 탭 내용입니다.
              </TabsContent>
            </Tabs>

            <Tabs defaultValue="all">
              <TabsList variant="pill">
                <TabsTrigger value="all">전체</TabsTrigger>
                <TabsTrigger value="mine">내 회의</TabsTrigger>
                <TabsTrigger value="shared">공유됨</TabsTrigger>
              </TabsList>
            </Tabs>

            <Tabs defaultValue="file" className="max-w-sm">
              <TabsList variant="choice" aria-label="기록 방식 예시">
                <TabsTrigger value="file">오디오 파일</TabsTrigger>
                <TabsTrigger value="live">실시간 녹음</TabsTrigger>
              </TabsList>
            </Tabs>

            <nav
              aria-label="사이드바 예시"
              className="w-64 rounded-md border border-border bg-sidebar p-2"
            >
              <ul className="flex flex-col gap-0.5">
                <li>
                  <SidebarItem
                    icon={<HomeIcon />}
                    label="대시보드"
                    active
                    count={4}
                  />
                </li>
                <li>
                  <SidebarItem
                    icon={<MicIcon />}
                    label="주간 회의"
                    sub="오늘 14:00 · 8명"
                    meta="2h"
                  />
                </li>
                <li>
                  <SidebarItem icon={<Gear />} label="설정" />
                </li>
              </ul>
            </nav>
          </div>
        </Section>

        <Section title="Meeting (CommandBar · Utterance · SpeakerTrack · LensItem)">
          <div className="flex w-full flex-col gap-6">
            <Button
              variant="secondary"
              iconRight={<Kbd>⌘K</Kbd>}
              onClick={() => setCmdOpen(true)}
            >
              명령 팔레트 열기
            </Button>

            <div className="flex flex-col rounded-md border border-border bg-card p-2">
              <Utterance
                speaker={1}
                name="김지훈"
                time="04:12"
                onJump={() => {}}
              >
                이번 스프린트 목표는 검색 품질 개선입니다.
              </Utterance>
              <Utterance
                speaker={2}
                name="이서연"
                time="04:30"
                active
                onJump={() => {}}
              >
                인덱싱 파이프라인부터 정리하면 좋겠어요.
              </Utterance>
              <Utterance
                speaker={3}
                name="박도윤"
                time="05:02"
                quoted
                onBookmark={() => {}}
              >
                예산은 다음 주에 다시 확인이 필요합니다.
              </Utterance>
            </div>

            <div className="rounded-md border border-border bg-card p-3">
              <SpeakerTrack
                speaker={1}
                name="김지훈"
                duration="12:40"
                playhead={head}
                onSeek={setHead}
                segments={[
                  { start: 0, end: 0.18 },
                  { start: 0.3, end: 0.52 },
                  { start: 0.72, end: 0.8, soft: true },
                ]}
              />
              <SpeakerTrack
                speaker={2}
                name="이서연"
                duration="08:05"
                playhead={head}
                onSeek={setHead}
                segments={[
                  { start: 0.2, end: 0.32 },
                  { start: 0.55, end: 0.7 },
                ]}
              />
              <SpeakerTrack
                speaker={3}
                name="박도윤"
                duration="03:22"
                playhead={head}
                onSeek={setHead}
                segments={[{ start: 0.82, end: 0.95 }]}
              />
            </div>

            <div className="flex flex-col gap-2">
              <LensItem source="ai" evidence="04:12" onJump={() => {}}>
                다음 스프린트 범위를 금요일까지 확정한다.
              </LensItem>
              <LensItem
                source="user"
                checkable
                done={done1}
                onToggle={() => setDone1((v) => !v)}
                assignee="이서연"
                assigneeSpeaker={2}
              >
                회의록 공유하기
              </LensItem>
              <LensItem
                source="hint"
                checkable
                done={done2}
                onToggle={() => setDone2((v) => !v)}
                assignee="박도윤"
                assigneeSpeaker={3}
                evidence="08:30"
                onJump={() => {}}
              >
                예산 재확인 필요
              </LensItem>
            </div>
          </div>
        </Section>

        <Section title="NoteEditor (마크다운 메모)">
          <div className="flex flex-wrap items-start gap-4">
            <NoteFrame label="읽기 · 편집 (직접 눌러 볼 수 있어요)">
              <NoteEditor
                body={note}
                onChange={setNote}
                saveState="saved"
                onRetrySave={() => toast({ title: "다시 저장했어요" })}
              />
            </NoteFrame>

            <NoteFrame label="빈 상태">
              <NoteEditor body={emptyNote} onChange={setEmptyNote} />
            </NoteFrame>

            <NoteFrame label="불러오는 중">
              <NoteEditor body="" onChange={() => {}} isLoading />
            </NoteFrame>

            <NoteFrame label="불러오기 실패">
              <NoteEditor
                body=""
                onChange={() => {}}
                isError
                onReload={() => toast({ title: "다시 불러왔어요" })}
              />
            </NoteFrame>
          </div>
        </Section>
      </div>
      <CommandBar
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        query={cmdQuery}
        onQueryChange={setCmdQuery}
        groups={cmdFiltered}
        onSelect={() => setCmdOpen(false)}
      />
      <Toaster />
    </main>
  );
}
