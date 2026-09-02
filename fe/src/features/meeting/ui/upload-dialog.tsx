import * as React from "react";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { isApiError } from "@/shared/api/client";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { DatePicker } from "@/shared/ui/date-picker";
import { Input } from "@/shared/ui/input";
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { toast } from "@/shared/ui/use-toast";
import type { ProcessingOverride } from "@/features/settings/api/types";
import { OverrideSection } from "@/features/settings/ui/override-section";

import { useUploadMeeting } from "../api/meetings";
import type { SpeakerBounds } from "../api/types";
import { Icon } from "./icons";
import { isSpeakerBoundsValid } from "../lib/speaker-bounds";
import { SpeakerCountField } from "./speaker-count-field";

/**
 * UploadDialog — 오디오 파일을 올려 새 회의를 생성한다. 파일(필수) + 제목/녹음
 * 일시(선택)를 받아 `useUploadMeeting`으로 multipart 전송하고, 성공 시 새 회의를
 * 선택해 처리 배너를 띄운다. 렌즈/요약은 실행 시점(자동/나중에)을 고를 수 있고,
 * "나중에"를 고르면 process_meeting payload의 followups가 꺼져 워커가 후속 job을
 * 큐잉하지 않는다.
 */

/** 후속 처리 실행 시점 — defer 플래그의 UI 표현. */
type FollowupTiming = "auto" | "later";

function timingOptions(task: string) {
  return [
    {
      value: "auto" as const,
      label: "자동 실행",
      ariaLabel: `${task} 자동 실행`,
    },
    {
      value: "later" as const,
      label: "나중에 실행",
      ariaLabel: `${task} 나중에 실행`,
    },
  ];
}

/** 후속 작업 한 줄 — 이름·설명과 실행 시점 세그먼트. */
function FollowupRow({
  task,
  description,
  deferred,
  onDeferredChange,
}: {
  task: string;
  description: string;
  deferred: boolean;
  onDeferredChange: (deferred: boolean) => void;
}) {
  const taskLabelId = React.useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span id={taskLabelId} className="text-sm font-medium text-foreground">
          {task}
        </span>
        <span className="truncate text-xs text-[color:var(--text-muted)]">
          {description}
        </span>
      </div>
      <SegmentedControl<FollowupTiming>
        className="shrink-0"
        aria-labelledby={taskLabelId}
        options={timingOptions(task)}
        value={deferred ? "later" : "auto"}
        onChange={(timing) => onDeferredChange(timing === "later")}
      />
    </div>
  );
}

/** 바이트 → "12.3 MB" 표시 문자열. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 날짜 + "HH:MM"(비면 자정)을 로컬 시각 기준 ISO 문자열로 합친다. */
function combineToISO(date: Date, time: string): string {
  const [h, m] = time ? time.split(":").map(Number) : [0, 0];
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    h || 0,
    m || 0,
  ).toISOString();
}

type UploadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 업로드 성공 시 새 회의 id — 셸이 해당 회의를 선택해 처리 배너를 띄운다. */
  onUploaded: (id: string) => void;
};

export function UploadDialog({
  open,
  onOpenChange,
  onUploaded,
}: UploadDialogProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const recordedLabelId = React.useId();
  const recordedHintId = React.useId();
  const followupsLabelId = React.useId();
  const followupsHintId = React.useId();
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [recordedDate, setRecordedDate] = React.useState<Date | null>(null);
  const [recordedTime, setRecordedTime] = React.useState("");
  const [processing, setProcessing] = React.useState<
    ProcessingOverride | undefined
  >(undefined);
  const [speakers, setSpeakers] = React.useState<SpeakerBounds | undefined>(
    undefined,
  );
  // 기본은 둘 다 자동 실행(=미루지 않음). 렌즈/요약은 LLM을 돌려 환경에 따라
  // 오래 걸리므로, 급할 때만 "나중에 실행"으로 돌려 전사까지만 받는다.
  const [deferLens, setDeferLens] = React.useState(false);
  const [deferSummary, setDeferSummary] = React.useState(false);
  const upload = useUploadMeeting();

  const resetForm = () => {
    setFile(null);
    setTitle("");
    setRecordedDate(null);
    setRecordedTime("");
    setProcessing(undefined);
    setSpeakers(undefined);
    setDeferLens(false);
    setDeferSummary(false);
  };

  const handleOpenChange = (next: boolean) => {
    // 업로드 중에는 닫히지 않도록 막는다.
    if (!next && upload.isPending) return;
    if (!next) resetForm();
    onOpenChange(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || upload.isPending || !isSpeakerBoundsValid(speakers)) return;
    upload.mutate(
      {
        file,
        title: title.trim() || undefined,
        recordedAt: recordedDate
          ? combineToISO(recordedDate, recordedTime)
          : undefined,
        processing,
        speakers,
        deferLens,
        deferSummary,
      },
      {
        onSuccess: (summary) => {
          toast({
            variant: "success",
            title: "업로드 완료",
            description: "회의 처리를 시작했어요.",
          });
          resetForm();
          onOpenChange(false);
          onUploaded(summary.id);
        },
        onError: (error) => {
          if (isDemoBlocked(error)) return;
          toast({
            variant: "error",
            title: "업로드 실패",
            description: isApiError(error)
              ? error.message
              : "업로드 중 오류가 발생했어요.",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 회의 업로드</DialogTitle>
          <DialogDescription>
            오디오 파일을 올리면 화자 분리와 전사가 자동으로 진행돼요.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-[color:var(--text-secondary)]">
              오디오 파일
            </span>
            <div className="flex items-center gap-2.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                iconLeft={<Icon name="mic" size={15} />}
                onClick={() => fileInputRef.current?.click()}
              >
                파일 선택
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--text-muted)]">
                {file
                  ? `${file.name} · ${formatBytes(file.size)}`
                  : "선택된 파일이 없어요"}
              </span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <Input
            label="제목 (선택)"
            placeholder="회의 제목"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <div className="flex flex-col gap-1.5">
            <span
              id={recordedLabelId}
              className="text-sm font-medium text-[color:var(--text-secondary)]"
            >
              녹음 일시 (선택)
            </span>
            <div
              role="group"
              aria-labelledby={recordedLabelId}
              aria-describedby={recordedHintId}
              className="flex items-center gap-2"
            >
              <div className="min-w-0 flex-1">
                <DatePicker value={recordedDate} onChange={setRecordedDate} />
              </div>
              <Input
                type="time"
                value={recordedTime}
                onChange={(e) => setRecordedTime(e.target.value)}
                containerClassName="w-[116px] shrink-0"
                aria-label="녹음 시각"
              />
            </div>
            <p
              id={recordedHintId}
              className="text-sm text-[color:var(--text-muted)]"
            >
              비우면 업로드 시각으로 기록됩니다.
            </p>
          </div>

          <SpeakerCountField value={speakers} onChange={setSpeakers} />

          <div className="flex flex-col gap-1.5">
            <span
              id={followupsLabelId}
              className="text-sm font-medium text-[color:var(--text-secondary)]"
            >
              후속 처리
            </span>
            <p
              id={followupsHintId}
              className="text-sm text-[color:var(--text-muted)]"
            >
              전사가 끝난 뒤 실행할 추가 작업이에요. 자동으로 실행하거나, 나중에
              회의 화면에서 직접 실행할 수 있어요.
            </p>
            <div
              role="group"
              aria-labelledby={followupsLabelId}
              aria-describedby={followupsHintId}
              className="mt-0.5 flex flex-col gap-3"
            >
              <FollowupRow
                task="렌즈 추출"
                description="할 일·결정·약속을 뽑아내요."
                deferred={deferLens}
                onDeferredChange={setDeferLens}
              />
              <FollowupRow
                task="요약"
                description="주요 주제와 단락별 요약을 만들어요."
                deferred={deferSummary}
                onDeferredChange={setDeferSummary}
              />
            </div>
          </div>

          <OverrideSection value={processing} onChange={setProcessing} />

          <DialogFooter className="mt-1">
            <DialogClose asChild>
              <Button
                type="button"
                variant="secondary"
                disabled={upload.isPending}
              >
                취소
              </Button>
            </DialogClose>
            <Button
              type="submit"
              loading={upload.isPending}
              disabled={
                !file || upload.isPending || !isSpeakerBoundsValid(speakers)
              }
            >
              업로드
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
