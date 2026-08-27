import * as React from "react";

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
import { toast } from "@/shared/ui/use-toast";
import { OverrideSection } from "@/features/settings/ui/override-section";
import type { ProcessingOverride } from "@/features/settings/api/types";

import { useReprocessMeeting } from "../api/meetings";
import type { SpeakerBounds } from "../api/types";
import { isSpeakerBoundsValid } from "../lib/speaker-bounds";
import { SpeakerCountField } from "./speaker-count-field";

/**
 * ReprocessDialog — 회의 재처리 확인. 기존 전사/화자 결과를 새 결과로
 * 덮어쓴다는 점을 고지하고, job 한정 오버라이드 섹션(기본 접힘)을 제공한다.
 */

type ReprocessDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meeting: { id: string; title: string | null };
};

export function ReprocessDialog({
  open,
  onOpenChange,
  meeting,
}: ReprocessDialogProps) {
  const [processing, setProcessing] = React.useState<
    ProcessingOverride | undefined
  >(undefined);
  const [speakers, setSpeakers] = React.useState<SpeakerBounds | undefined>(
    undefined,
  );
  const reprocess = useReprocessMeeting();

  const handleOpenChange = (next: boolean) => {
    if (!next && reprocess.isPending) return;
    if (!next) {
      setProcessing(undefined);
      setSpeakers(undefined);
    }
    onOpenChange(next);
  };

  const handleConfirm = () => {
    if (reprocess.isPending || !isSpeakerBoundsValid(speakers)) return;
    reprocess.mutate(
      { id: meeting.id, processing, speakers },
      {
        onSuccess: () => {
          toast({
            variant: "success",
            title: "재처리를 시작했어요.",
            description: "완료되면 새 결과로 바뀌어요.",
          });
          setProcessing(undefined);
          setSpeakers(undefined);
          onOpenChange(false);
        },
        onError: (error) => {
          toast({
            variant: "error",
            title: "재처리에 실패했어요.",
            description: isApiError(error) ? error.message : undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>회의 재처리</DialogTitle>
          <DialogDescription>
            “{meeting.title ?? "제목 없음"}” 회의를 처음부터 다시 처리해요. 기존
            전사·화자 분리 결과는 새 결과로 덮어써요.
          </DialogDescription>
        </DialogHeader>

        <SpeakerCountField value={speakers} onChange={setSpeakers} />

        <OverrideSection value={processing} onChange={setProcessing} />

        <DialogFooter>
          <DialogClose asChild>
            <Button
              type="button"
              variant="secondary"
              disabled={reprocess.isPending}
            >
              취소
            </Button>
          </DialogClose>
          <Button
            type="button"
            loading={reprocess.isPending}
            disabled={reprocess.isPending || !isSpeakerBoundsValid(speakers)}
            onClick={handleConfirm}
          >
            재처리 시작
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
