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
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onContinue())}
    >
      <DialogContent
        showCloseButton={false}
        className="z-[10050]"
        overlayClassName="z-[10050]"
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
          <Button autoFocus onClick={onContinue}>
            계속 둘러보기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
