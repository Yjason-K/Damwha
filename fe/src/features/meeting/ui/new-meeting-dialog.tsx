import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { isApiError } from "@/shared/api/client";
import { env } from "@/shared/config/env";
import { isTourActive } from "@/features/demo/model/tour-active";
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
import { TimePicker } from "@/shared/ui/time-picker";
import { toast } from "@/shared/ui/use-toast";
import type { ProcessingOverride } from "@/features/settings/api/types";
import { OverrideSection } from "@/features/settings/ui/override-section";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/shared/ui/tabs";
import { useStartLive } from "../api/live";
import { defaultLiveTitle } from "../lib/default-live-title";
import {
  requestCaptureDevices,
  type CaptureBlock,
  LiveCaptureCancelled,
} from "../lib/live-recorder";
import {
  beginLiveCapture,
  cancelLivePreparation,
  LiveCaptureBusy,
  prepareLiveRecorder,
} from "../lib/live-session";

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

/**
 * 실시간 녹음 시작 전 게이트 상태(설계 §5.2). insecure context·권한 거부·장치 없음이면
 * 아예 회의를 만들지 않는다 — 원 설계에서 회의 중간에 audio_device_failed로 터지던
 * 실패를 전부 시작 전으로 옮긴다. 게이트는 live 탭이 열릴 때 돌고, 통과해야만
 * "녹음 시작"이 열린다: 권한을 받아 낸 뒤여야 마이크 목록에 진짜 이름이 나오고,
 * 사용자가 무엇으로 녹음하는지 보고 고를 수 있다.
 */
type CaptureGate = { reason: CaptureBlock } | { devices: MediaDeviceInfo[] };

const CAPTURE_GATE_MESSAGE: Record<CaptureBlock, string> = {
  insecure:
    "HTTPS에서만 녹음할 수 있어요. localhost 또는 인증서가 있는 주소로 접속해 주세요.",
  denied:
    "마이크 권한이 거부돼 있어요. 브라우저의 사이트 설정에서 허용해 주세요.",
  no_device: "입력 장치를 찾지 못했어요.",
  unavailable:
    "마이크를 열지 못했어요. 다른 앱이 쓰고 있는지 확인한 뒤 다시 시도해 주세요.",
};

/**
 * deviceId가 빈 문자열인 장치(권한 없이 열거된 상태의 브라우저가 준다)를 위한 값.
 * Radix Select는 빈 value를 허용하지 않아 그대로 넣으면 렌더가 터진다. 시작할 때는
 * 다시 undefined로 풀어 제약 없이(브라우저 기본 장치로) 연다.
 */
const DEFAULT_DEVICE = "__default__";

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
  const [gate, setGate] = React.useState<CaptureGate | null>(null);
  const [gateChecking, setGateChecking] = React.useState(false);
  const [deviceId, setDeviceId] = React.useState<string | undefined>(undefined);
  /**
   * 게이트의 세대. 0은 "아직 안 돌았다"라 효과가 이 값만 보고 한 번만 건다 —
   * StrictMode의 이중 실행도 여기서 걸러진다. 늦게 끝난 게이트가 닫힌 다이얼로그나
   * 새 시도의 결과를 덮어쓰지 않도록, 결과를 쓰기 전에 자기 세대를 다시 확인한다.
   */
  const gateRunRef = React.useRef(0);
  const deviceLabelId = React.useId();
  const upload = useUploadMeeting();
  const start = useStartLive();
  /**
   * 게이트 확인 → 캡처 준비 → 회의 생성 → begin ACK. 이 전부가 한 번의 "녹음 시작"이라
   * 그 동안 두 번째 시작이 들어오면 마이크가 둘, 회의가 둘 생긴다. state는 같은 tick의
   * 연타를 막지 못하므로(리렌더 전에 두 번째 클릭이 들어온다) ref로 잠그고, state는
   * 버튼의 loading 표시에만 쓴다.
   */
  const startingRef = React.useRef(false);
  const [starting, setStarting] = React.useState(false);
  const pending = upload.isPending || start.isPending;
  /**
   * 소스 탭을 잠그는 조건. 게이트 확인은 **넣지 않는다** — 그 대기에는 권한 프롬프트가
   * 들어 있어 얼마든지 길어질 수 있고(설계 §6.4), 프롬프트를 띄운 채 사용자를 live
   * 탭에 붙잡아 두면 파일 업로드로 돌아갈 길이 막힌다.
   */
  const sourceLocked = pending || starting;
  /**
   * 제출 버튼이 도는 조건. starting·gateChecking은 live 탭에만 있는 상태라 소스로
   * 걸러 낸다 — 권한 프롬프트를 띄워 둔 채 파일 탭으로 돌아온 사용자의 업로드 버튼이
   * 같이 잠기면 안 된다.
   */
  const submitBusy =
    pending || (source === "live" && (starting || gateChecking));

  /**
   * 권한을 요청하고 고를 수 있는 마이크를 받아 온다. 프롬프트에는 시간 제한을 두지
   * 않는다(설계 §6.4) — 사람이 프롬프트를 읽는 시간을 실패로 세면 안 된다.
   */
  const runGate = React.useCallback(async () => {
    const run = ++gateRunRef.current;
    setGateChecking(true);
    const result = await requestCaptureDevices();
    // 그 사이 다이얼로그가 닫혔거나(resetForm이 0으로 되돌린다) 다시 확인을 눌렀다.
    if (run !== gateRunRef.current) return;
    setGate(
      result.ok ? { devices: result.devices } : { reason: result.reason },
    );
    if (result.ok)
      setDeviceId(
        (prev) => prev ?? result.devices[0]?.deviceId ?? DEFAULT_DEVICE,
      );
    setGateChecking(false);
  }, []);

  React.useEffect(() => {
    if (!open || source !== "live" || env.demoMode) return;
    if (gateRunRef.current !== 0) return;
    void runGate();
  }, [open, source, gate, runGate]);

  const changeSource = (value: string) => {
    if (sourceLocked) return;
    const next = value === "live" ? "live" : "file";
    setSource(next);
    // 데모는 기억하지 않는다 — readSource가 늘 file을 주므로 저장해도 죽은 값이고,
    // 투어는 모달이 파일 탭으로 열린다는 전제로 단계를 짠다.
    if (env.demoMode) return;
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
    setStarting(false);
  };

  /**
   * 게이트는 폼 입력이 아니라 "다이얼로그 한 번 열림"에 묶인다 — 시작에 성공해 폼을
   * 비울 때까지 같이 지우면, 닫히기 전 한 프레임 동안 효과가 게이트를 다시 돌려
   * 방금 시작한 녹음 위로 권한 프롬프트를 한 번 더 띄운다. 닫을 때만 되돌린다.
   */
  const resetGate = () => {
    setGate(null);
    setGateChecking(false);
    gateRunRef.current = 0;
    setDeviceId(undefined);
  };

  const handleOpenChange = (next: boolean) => {
    // 업로드 또는 녹음 시작 요청 중에는 닫히지 않도록 막는다.
    if (!next && pending) return;
    if (!next) {
      // 준비 중이던 캡처(권한 프롬프트 대기 중일 수도 있다)를 놓아 준다 — 늦게 도착한
      // 스트림을 아무도 안 닫으면 녹음 표시등만 켜진 채 남는다 (설계 §6.4). 이미 회의에
      // 붙은 녹음은 건드리지 않는다.
      void cancelLivePreparation();
      resetForm();
      resetGate();
    }
    onOpenChange(next);
  };

  /**
   * 시작 실패 토스트 — "이미 녹음 중"만 따로 말해 준다(서버의 409든, 이 탭이 이미 녹음
   * 중이라 준비가 거절된 것이든 사용자에게는 같은 상황이다).
   *
   * 설명문으로 `error.message`를 쓰는 것은 **ApiError일 때뿐**이다. 레코더와 세션이 던지는
   * 메시지는 전부 진단용 영어라("the capture worklet never acknowledged begun"), 그대로
   * 실으면 한국어 UI에 영어 내부 문구가 뜬다 (`fe/CLAUDE.md`).
   */
  const showStartError = (error: unknown) => {
    if (isDemoBlocked(error)) return;
    const conflict =
      error instanceof LiveCaptureBusy ||
      (isApiError(error) && error.statusCode === 409);
    toast({
      variant: "error",
      title: conflict ? "이미 녹음 중이에요" : "녹음을 시작하지 못했어요",
      description: conflict
        ? "진행 중인 녹음을 먼저 종료해 주세요."
        : isApiError(error)
          ? error.message
          : "잠시 후 다시 시도해 주세요.",
    });
  };

  /**
   * 실시간 녹음 시작 (설계 §6). 준비가 **먼저**다 — 권한 거절·장치 부재·Worklet 로딩
   * 실패는 `/meetings/live`를 부르기 전에 드러나야 하고, 그래야 실패가 빈 회의를 남기지
   * 않는다. 201을 받은 뒤의 실패는 id를 알고 있으므로 beginLiveCapture가 0바이트 stop으로
   * 정리한다. 생성 POST 자체는 재시도하지 않는다.
   */
  const startLive = async () => {
    let capture;
    try {
      capture = await prepareLiveRecorder(
        deviceId === DEFAULT_DEVICE ? undefined : deviceId,
      );
    } catch (error) {
      // 사용자가 취소했거나 다른 시작에 밀린 준비 — 실패가 아니므로 조용히 접는다.
      if (error instanceof LiveCaptureCancelled) return;
      if (error instanceof LiveCaptureBusy) {
        showStartError(error);
        return;
      }
      // 권한 거절·장치 부재·Worklet 로딩 실패가 전부 여기로 온다. 그 예외의 message는
      // 진단용 영어(DOMException "Permission denied", "browser gave 48000 Hz…")라 그대로
      // 보여주지 않고, 사용자가 실제로 할 수 있는 일을 말한다.
      toast({
        variant: "error",
        title: "마이크를 열지 못했어요",
        description: "마이크 권한과 연결을 확인한 뒤 다시 시도해 주세요.",
      });
      return;
    }
    try {
      const meeting = await start.mutateAsync({
        title: title.trim() || defaultLiveTitle(),
        processing,
        speakers,
        defer_lens: deferLens || undefined,
        defer_summary: deferSummary || undefined,
      });
      await beginLiveCapture(capture, meeting.id);
      toast({
        variant: "success",
        title: "녹음 시작",
        description: "발화가 실시간으로 표시돼요.",
      });
      resetForm();
      onOpenChange(false);
      onCreated(meeting.id);
    } catch (error) {
      // dispose()가 아니라 이것을 부른다: dispose는 레코더 자원만 놓아 주고 live-session의
      // `active`는 죽은 캡처를 계속 가리킨다. cancelLivePreparation이 짝이 맞는 호출이라
      // 예약까지 함께 놓는다 — 그리고 회의에 이미 붙은 녹음은 건드리지 않으므로,
      // beginLiveCapture가 성공한 뒤의 예외로 살아 있는 녹음을 죽이지 않는다.
      await cancelLivePreparation();
      // 다른 시작에 밀린 캡처 — 사용자가 한 일이 아니므로 오류로 알리지 않는다.
      if (error instanceof LiveCaptureCancelled) return;
      showStartError(error);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || startingRef.current || !isSpeakerBoundsValid(speakers))
      return;
    if (source === "live") {
      // 데모는 녹음을 시작하지 않는다. 버튼도 막혀 있지만 Enter로도 들어온다.
      if (env.demoMode) return;
      // 게이트(권한 확인 + 마이크 선택)를 통과하지 못했으면 시작하지 않는다 — 버튼도
      // 막혀 있지만, 폼 제출은 버튼 말고도 들어온다(Enter).
      if (gateChecking || !gate || "reason" in gate || deviceId === undefined)
        return;
      startingRef.current = true;
      setStarting(true);
      void startLive().finally(() => {
        startingRef.current = false;
        setStarting(false);
      });
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
      <DialogContent
        /**
         * 투어 중에는 바깥 클릭·ESC로 닫지 않는다. driver의 오버레이가 이 모달 위를 덮고
         * 있어서 스포트라이트 밖을 누르면 Radix가 "바깥 클릭"으로 읽고 모달을 닫아 버리는데,
         * 그러면 다음 단계가 모달 안의 버튼을 찾지 못해 통째로 건너뛴다. 투어를 그만두는
         * 경로는 driver의 확인 모달(TourNavigationGuard) 하나로 남긴다 — 닫기(X)·취소는
         * 그대로 열려 있다.
         */
        onInteractOutside={(e) => {
          if (isTourActive()) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (isTourActive()) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>새 회의 기록하기</DialogTitle>
          <DialogDescription>
            오디오 파일을 올리거나 실시간으로 녹음해 회의를 기록해요.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Tabs value={source} onValueChange={changeSource}>
            <TabsList variant="choice" aria-label="회의 기록 방식">
              <TabsTrigger
                value="file"
                disabled={sourceLocked}
                className="flex-1"
              >
                오디오 파일
              </TabsTrigger>
              <TabsTrigger
                value="live"
                disabled={sourceLocked}
                className="flex-1"
              >
                실시간 녹음
              </TabsTrigger>
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
                  <div className="w-[116px] shrink-0">
                    <TimePicker
                      value={recordedTime}
                      onChange={setRecordedTime}
                      aria-label="녹음 시각"
                    />
                  </div>
                </div>
                <p
                  id={recordedHintId}
                  className="text-sm text-[color:var(--text-muted)]"
                >
                  비우면 업로드 시각으로 기록됩니다.
                </p>
              </div>
            </TabsContent>
            <TabsContent value="live" className="flex flex-col gap-3">
              <div>
                <p className="text-sm text-[color:var(--text-secondary)]">
                  이 브라우저의 마이크로 녹음해요. 지금 보고 있는 기기의
                  마이크를 사용합니다.
                </p>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  녹음 시작을 누르면 발화가 실시간으로 표시되고, 종료 후 화자
                  분리와 전사가 진행돼요.
                </p>
              </div>
              {env.demoMode ? (
                <p
                  role="note"
                  className="text-sm text-[color:var(--text-muted)]"
                >
                  데모에서는 녹음을 시작할 수 없어요 — 마이크 권한을 묻지 않고,
                  녹음을 받아 처리할 워커도 없습니다. 실제 설치본에서는 여기서
                  마이크를 고르고 바로 녹음이 시작돼요.
                </p>
              ) : null}
              {gateChecking ? (
                <p className="text-sm text-[color:var(--text-muted)]">
                  마이크를 확인하고 있어요. 브라우저가 권한을 물어보면 허용해
                  주세요.
                </p>
              ) : null}
              {gate && "reason" in gate ? (
                <div className="flex flex-col items-start gap-2">
                  <p
                    role="alert"
                    className="text-sm text-[color:var(--red-text)]"
                  >
                    {CAPTURE_GATE_MESSAGE[gate.reason]}
                  </p>
                  {/* 다이얼로그를 닫았다 열지 않고도 다시 시도할 수 있어야 한다. */}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void runGate()}
                  >
                    다시 확인
                  </Button>
                </div>
              ) : null}
              {gate && "devices" in gate ? (
                <div className="flex flex-col gap-1.5">
                  <span
                    id={deviceLabelId}
                    className="text-sm font-medium text-[color:var(--text-secondary)]"
                  >
                    마이크
                  </span>
                  <Select value={deviceId} onValueChange={setDeviceId}>
                    <SelectTrigger aria-labelledby={deviceLabelId}>
                      <SelectValue placeholder="마이크 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      {gate.devices.map((d, i) => (
                        <SelectItem
                          key={d.deviceId || i}
                          value={d.deviceId || DEFAULT_DEVICE}
                        >
                          {d.label || `마이크 ${i + 1}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </TabsContent>
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
              loading={submitBusy}
              disabled={
                (source === "file" && !demoTour && !file) ||
                (source === "live" &&
                  (env.demoMode ||
                    !gate ||
                    "reason" in gate ||
                    deviceId === undefined)) ||
                submitBusy ||
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
