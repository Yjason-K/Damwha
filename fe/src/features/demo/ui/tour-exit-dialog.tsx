import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

type Props = { open: boolean; onContinue: () => void; onQuit: () => void };

/** 둘러보기 종료 확인(투어 설계 §2.6). driver 오버레이(z-index 10000) 위에 떠야 한다. */
export function TourExitDialog({ open, onContinue, onQuit }: Props) {
  const continueRef = React.useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onContinue())}
    >
      <DialogContent
        showCloseButton={false}
        // z-index는 driver 오버레이(10000) 위, damwha-tour-exit는 driver.css의
        // `.driver-active * { pointer-events: none }`에서 이 모달을 빼는 훅(tour.css).
        className="damwha-tour-exit z-[10050]"
        overlayClassName="damwha-tour-exit z-[10050]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          continueRef.current?.focus();
        }}
        // Escape로는 닫지 않는다 — driver도 Escape를 듣고 있어서, Radix가 keydown으로 닫으면
        // 뒤이은 keyup이 종료 요청으로 이 모달을 다시 연다. 나가는 길은 두 버튼뿐이고
        // 포커스는 이미 "계속 둘러보기"에 있다.
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>둘러보기를 그만둘까요?</DialogTitle>
          <DialogDescription>
            아직 보여드릴 단계가 남아 있어요. 그만둬도 왼쪽 아래 "둘러보기"로
            다시 시작할 수 있어요.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onQuit}>
            그만두기
          </Button>
          <Button ref={continueRef} onClick={onContinue}>
            계속 둘러보기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
