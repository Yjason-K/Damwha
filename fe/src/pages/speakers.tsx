import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { useSpeakers } from "@/features/speaker/api/speakers";
import { SpeakerRow } from "@/features/speaker/ui/speaker-row";
import { EnrollSpeakerDialog } from "@/features/speaker/ui/enroll-speaker-dialog";
import { toErrorMessage } from "@/features/speaker/ui/error";

function PlusIcon() {
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

/** 목록 로딩 상태. */
function LoadingState() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex flex-col items-center gap-3 py-16 text-[color:var(--text-muted)]"
    >
      <span
        aria-hidden="true"
        className="size-6 animate-spin rounded-full border-2 border-current border-r-transparent"
      />
      <span className="text-sm">화자 목록을 불러오는 중이에요…</span>
    </div>
  );
}

/** 목록 조회 실패 상태. */
function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card padding="lg" className="flex flex-col items-center gap-3 text-center">
      <p className="text-base font-medium text-foreground">
        화자 목록을 불러오지 못했어요.
      </p>
      <p className="text-sm text-[color:var(--text-muted)]">{message}</p>
      <Button variant="secondary" onClick={onRetry}>
        다시 시도
      </Button>
    </Card>
  );
}

/** 화자가 하나도 없을 때의 안내 + 등록 CTA. */
function EmptyState({ onRegister }: { onRegister: () => void }) {
  return (
    <Card
      padding="lg"
      className="flex flex-col items-center gap-4 py-14 text-center"
    >
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-full bg-[var(--accent-2)] text-[color:var(--accent-text)] [&_svg]:size-6"
      >
        <MicIcon />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-h2 font-semibold text-foreground">
          아직 등록된 화자가 없어요
        </h2>
        <p className="text-sm text-[color:var(--text-muted)]">
          화자를 등록하면 회의에서 목소리를 자동으로 식별할 수 있어요.
        </p>
      </div>
      <Button iconLeft={<PlusIcon />} onClick={onRegister}>
        화자 등록
      </Button>
    </Card>
  );
}

/** 화자 관리 페이지 — 목록 조회 + 등록/이름 변경/삭제. */
export function SpeakersPage() {
  const [enrollOpen, setEnrollOpen] = React.useState(false);
  const speakers = useSpeakers();

  return (
    <main className="col-start-2 h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
        <header className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-display font-bold">화자 관리</h1>
            <p className="text-base text-[color:var(--text-muted)]">
              등록된 화자의 성문을 관리하고 새 화자를 추가할 수 있어요.
            </p>
          </div>
          <Button iconLeft={<PlusIcon />} onClick={() => setEnrollOpen(true)}>
            화자 등록
          </Button>
        </header>

        {speakers.isPending ? (
          <LoadingState />
        ) : speakers.isError ? (
          <ErrorState
            message={toErrorMessage(speakers.error)}
            onRetry={() => {
              void speakers.refetch();
            }}
          />
        ) : speakers.data.length === 0 ? (
          <EmptyState onRegister={() => setEnrollOpen(true)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {speakers.data.map((speaker, index) => (
              <li key={speaker.id}>
                <SpeakerRow speaker={speaker} tint={index + 1} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <EnrollSpeakerDialog open={enrollOpen} onOpenChange={setEnrollOpen} />
    </main>
  );
}
