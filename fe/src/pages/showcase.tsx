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

function Plus() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function Gear() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" strokeLinecap="round" />
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
      </div>
    </main>
  );
}
