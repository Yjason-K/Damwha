import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { isApiError } from "@/shared/api/client";
import { env } from "@/shared/config/env";
import { DemoUploadSource } from "@/features/demo/ui/demo-upload-source";
import { startUploadSimulation } from "@/features/demo/model/upload-simulation";
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

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/shared/ui/tabs";
import { useStartLive } from "../api/live";
import { defaultLiveTitle } from "../lib/default-live-title";

import { useUploadMeeting } from "../api/meetings";
import type { SpeakerBounds } from "../api/types";
import { Icon } from "./icons";
import { isSpeakerBoundsValid } from "../lib/speaker-bounds";
import { SpeakerCountField } from "./speaker-count-field";

/** 파일 업로드와 실시간 녹음이 공통 설정을 공유하는 회의 생성 모달. */
type MeetingSource = "file" | "live";
const SOURCE_KEY = "damwha:new-meeting-source";

function readSource(): MeetingSource {
  if (env.demoMode) return "file";
  try {
    return localStorage.getItem(SOURCE_KEY) === "live" ? "live" : "file";
  } catch {
    return "file";
  }
}

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

type NewMeetingDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 업로드 또는 녹음 시작 성공 시 새 회의로 이동한다. */
  onCreated: (id: string) => void;
};

export function NewMeetingDialog({
  open,
  onOpenChange,
  onCreated,
}: NewMeetingDialogProps) {
  const [source, setSource] = React.useState<MeetingSource>(readSource);
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
  const start = useStartLive();
  const pending = upload.isPending || start.isPending;

  const changeSource = (value: string) => {
    if (pending || env.demoMode) return;
    const next = value === "live" ? "live" : "file";
    setSource(next);
    try {
      localStorage.setItem(SOURCE_KEY, next);
    } catch {
      // 저장소를 사용할 수 없어도 현재 모달의 선택은 유지한다.
    }
  };
  const queryClient = useQueryClient();
  const demoTour = env.demoTour; // null이면 실제 업로드 경로

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
    // 업로드 또는 녹음 시작 요청 중에는 닫히지 않도록 막는다.
    if (!next && pending) return;
    if (!next) resetForm();
    onOpenChange(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || !isSpeakerBoundsValid(speakers)) return;
    if (source === "live" && !env.demoMode) {
      start.mutate(
        {
          title: title.trim() || defaultLiveTitle(),
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
              description: "마이크가 준비되면 발화가 실시간으로 표시돼요.",
            });
            resetForm();
            onOpenChange(false);
            onCreated(summary.id);
          },
          onError: (error) => {
            if (isDemoBlocked(error)) return;
            const conflict = isApiError(error) && error.statusCode === 409;
            toast({
              variant: "error",
              title: conflict
                ? "이미 녹음 중이에요"
                : "녹음을 시작하지 못했어요",
              description: conflict
                ? "진행 중인 녹음을 먼저 종료해 주세요."
                : isApiError(error)
                  ? error.message
                  : "잠시 후 다시 시도해 주세요.",
            });
          },
        },
      );
      return;
    }
    if (demoTour) {
      startUploadSimulation(demoTour.meetingId, queryClient);
      toast({
        variant: "success",
        title: "업로드 완료",
        description: "회의 처리를 시작했어요.",
      });
      resetForm();
      onOpenChange(false);
      onCreated(demoTour.meetingId);
      return;
    }
    if (!file) return;
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
          onCreated(summary.id);
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
          <DialogTitle>새 회의 기록하기</DialogTitle>
          <DialogDescription>
            오디오 파일을 올리거나 실시간으로 녹음해 회의를 기록해요.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Tabs value={source} onValueChange={changeSource}>
            <TabsList variant="choice" aria-label="회의 기록 방식">
              <TabsTrigger value="file" disabled={pending} className="flex-1">
                오디오 파일
              </TabsTrigger>
              {!env.demoMode && (
                <TabsTrigger value="live" disabled={pending} className="flex-1">
                  실시간 녹음
                </TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="file" className="flex flex-col gap-4">
              {demoTour ? (
                <DemoUploadSource fileLabel={demoTour.fileLabel} />
              ) : (
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
              )}

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
                    <DatePicker
                      value={recordedDate}
                      onChange={setRecordedDate}
                    />
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
            </TabsContent>
            {!env.demoMode && (
              <TabsContent value="live">
                <p className="text-sm text-[color:var(--text-secondary)]">
                  서버로 사용하는 Mac의 마이크로 녹음해요. 접속한 기기의
                  마이크가 아닐 수 있어요.
                </p>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  녹음 시작을 누르면 발화가 실시간으로 표시되고, 종료 후 화자
                  분리와 전사가 진행돼요.
                </p>
              </TabsContent>
            )}
          </Tabs>

          <Input
            label="제목 (선택)"
            placeholder={
              source === "live"
                ? "비우면 녹음 날짜와 시간으로 저장돼요"
                : "회의 제목"
            }
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
              <Button type="button" variant="secondary" disabled={pending}>
                취소
              </Button>
            </DialogClose>
            <Button
              type="submit"
              data-tour="upload-submit"
              loading={pending}
              disabled={
                (source === "file" && !demoTour && !file) ||
                pending ||
                !isSpeakerBoundsValid(speakers)
              }
            >
              {source === "live" ? "녹음 시작" : "업로드 시작"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
