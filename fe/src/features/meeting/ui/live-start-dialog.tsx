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
import { Input } from "@/shared/ui/input";
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { toast } from "@/shared/ui/use-toast";
import type { ProcessingOverride } from "@/features/settings/api/types";
import { OverrideSection } from "@/features/settings/ui/override-section";

import { useStartLive } from "../api/live";
import type { SpeakerBounds } from "../api/types";
import { isSpeakerBoundsValid } from "../lib/speaker-bounds";
import { Icon } from "./icons";
import { SpeakerCountField } from "./speaker-count-field";

/**
 * LiveStartDialog — 워커 Mac의 마이크로 녹음을 시작한다. 업로드 모달에서 파일·녹음
 * 일시 필드를 뺀 것이다(녹음 일시는 워커가 첫 샘플 시각으로 찍는다). 제목은 브라우저
 * 시각으로 미리 채운다 — 컨테이너 API는 회의 시간대를 모른다 (설계 §4).
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "녹음 YYYY-MM-DD HH:mm" — 로컬 시각. */
export function defaultLiveTitle(now: Date = new Date()): string {
  return `녹음 ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

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

type LiveStartDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 세션이 만들어졌을 때 새 회의 id — 셸이 그 회의로 이동한다. */
  onStarted: (id: string) => void;
};

export function LiveStartDialog({
  open,
  onOpenChange,
  onStarted,
}: LiveStartDialogProps) {
  const followupsLabelId = React.useId();
  const [title, setTitle] = React.useState(() => defaultLiveTitle());
  const [processing, setProcessing] = React.useState<
    ProcessingOverride | undefined
  >(undefined);
  const [speakers, setSpeakers] = React.useState<SpeakerBounds | undefined>(
    undefined,
  );
  const [deferLens, setDeferLens] = React.useState(false);
  const [deferSummary, setDeferSummary] = React.useState(false);
  const start = useStartLive();

  const resetForm = () => {
    setTitle(defaultLiveTitle());
    setProcessing(undefined);
    setSpeakers(undefined);
    setDeferLens(false);
    setDeferSummary(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && start.isPending) return;
    if (!next) resetForm();
    onOpenChange(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (start.isPending || !isSpeakerBoundsValid(speakers)) return;
    start.mutate(
      {
        title: title.trim() || undefined,
        processing,
        speakers,
        defer_lens: deferLens || undefined,
        defer_summary: deferSummary || undefined,
      },
      {
        onSuccess: (summary) => {
          toast({
            variant: "success",
            title: "녹음 시작",
            description: "워커가 마이크를 열면 발화가 흘러와요.",
          });
          resetForm();
          onOpenChange(false);
          onStarted(summary.id);
        },
        onError: (error) => {
          if (isDemoBlocked(error)) return;
          const conflict = isApiError(error) && error.statusCode === 409;
          toast({
            variant: "error",
            title: conflict ? "이미 녹음 중이에요" : "녹음을 시작하지 못했어요",
            description: conflict
              ? "진행 중인 녹음을 먼저 종료해 주세요."
              : isApiError(error)
                ? error.message
                : "잠시 후 다시 시도해 주세요.",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>실시간 녹음</DialogTitle>
          <DialogDescription>
            워커가 도는 Mac의 마이크로 녹음해요. 발화가 실시간으로 표시되고,
            종료하면 정식 처리가 이어져요.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Input
            label="제목 (선택)"
            placeholder="회의 제목"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <SpeakerCountField value={speakers} onChange={setSpeakers} />

          <div className="flex flex-col gap-1.5">
            <span
              id={followupsLabelId}
              className="text-sm font-medium text-[color:var(--text-secondary)]"
            >
              후속 처리
            </span>
            <p className="text-sm text-[color:var(--text-muted)]">
              녹음을 종료하고 전사가 끝난 뒤 실행할 추가 작업이에요.
            </p>
            <div
              role="group"
              aria-labelledby={followupsLabelId}
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
                disabled={start.isPending}
              >
                취소
              </Button>
            </DialogClose>
            <Button
              type="submit"
              iconLeft={<Icon name="mic" size={15} />}
              loading={start.isPending}
              disabled={start.isPending || !isSpeakerBoundsValid(speakers)}
            >
              녹음 시작
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
