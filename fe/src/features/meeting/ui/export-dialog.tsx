import * as React from "react";

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
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { Switch } from "@/shared/ui/switch";

import type { Meeting } from "../model/types";
import {
  buildTranscriptExport,
  exportFilename,
  type ExportFormat,
} from "../lib/export-transcript";

/**
 * ExportDialog — 회의 전사를 txt/srt 파일로 내려받는다. 본문 생성은
 * `lib/export-transcript`의 순수 함수가 맡고 여기서는 선택지와 다운로드만
 * 다룬다.
 *
 * srt에는 시간 토글을 보이지 않는다 — 자막 규격이 시각을 요구하므로 끌 수
 * 있는 것처럼 보이면 거짓말이 된다. 화자 토글은 형식을 오갈 때 유지한다.
 */

export type ExportMeeting = Pick<
  Meeting,
  "title" | "date" | "utterances" | "speakers"
>;

type ExportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meeting: ExportMeeting;
};

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "txt", label: "TXT" },
  { value: "srt", label: "SRT" },
];

export function ExportDialog({
  open,
  onOpenChange,
  meeting,
}: ExportDialogProps) {
  const [format, setFormat] = React.useState<ExportFormat>("txt");
  const [timestamps, setTimestamps] = React.useState(true);
  const [speakers, setSpeakers] = React.useState(true);

  const empty = meeting.utterances.length === 0;

  const handleExport = () => {
    const body = buildTranscriptExport(meeting, format, {
      timestamps,
      speakers,
    });
    const blob = new Blob([body], {
      type:
        format === "srt"
          ? "application/x-subrip;charset=utf-8"
          : "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportFilename(meeting, format);
    anchor.click();
    URL.revokeObjectURL(url);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>회의 내용 내보내기</DialogTitle>
          <DialogDescription>
            “{meeting.title}” 회의의 전사를 파일로 저장해요.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <SegmentedControl
            options={FORMATS}
            value={format}
            onChange={setFormat}
            aria-label="파일 형식"
          />

          <div className="flex flex-col gap-3">
            {format === "txt" && (
              <Switch
                label="시간 기록 포함"
                checked={timestamps}
                onChange={(e) => setTimestamps(e.currentTarget.checked)}
              />
            )}
            <Switch
              label="화자 이름 포함"
              checked={speakers}
              onChange={(e) => setSpeakers(e.currentTarget.checked)}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              취소
            </Button>
          </DialogClose>
          <Button type="button" disabled={empty} onClick={handleExport}>
            내보내기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
