import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { tourRunner } from "../lib/tour-runner";
import { readTourState, writeTourState } from "../model/tour-state";

/**
 * 공개 데모 첫 방문 안내이자 둘러보기 입구(투어 설계 §2.3). 데모 빌드에서만 providers가
 * lazy로 붙인다. 정직성 항목(NotebookLM 샘플·읽기 전용)은 짧게 남긴다.
 */
export function DemoNoticeDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(() => !readTourState().noticeSeen);
  const startRef = useRef<HTMLButtonElement>(null);

  function close() {
    writeTourState({ noticeSeen: true });
    setOpen(false);
  }

  function startTour() {
    close();
    tourRunner.start(queryClient);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          startRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Damwha 공개 데모</DialogTitle>
          <DialogDescription>
            대화 녹음을 올리면 화자별 발화·요약·할 일로 정리해 주는
            서비스입니다. 둘러보기가 업로드부터 검색까지 1분 남짓에
            보여드립니다.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2 text-sm leading-normal text-[color:var(--text-secondary)]">
          <li>
            회의 오디오는 Google NotebookLM이 생성한{" "}
            <strong className="font-medium text-foreground">
              AI 대화 샘플
            </strong>
            입니다. 실제 인물의 음성이 아닙니다.
          </li>
          <li>결과는 이 샘플을 실제 파이프라인으로 처리한 그대로입니다.</li>
          <li>읽기 전용 데모라 편집·저장은 제한됩니다.</li>
        </ul>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            그냥 볼게요
          </Button>
          <Button ref={startRef} onClick={startTour}>
            둘러보기 시작
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
