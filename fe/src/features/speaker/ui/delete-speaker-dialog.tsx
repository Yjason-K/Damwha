import { isDemoBlocked } from "@/shared/api/demo-read-only";
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
import {
  useDeleteSpeaker,
  type SpeakerItem,
} from "@/features/speaker/api/speakers";
import { toErrorMessage } from "./error";

type DeleteSpeakerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  speaker: SpeakerItem;
};

/** 화자 삭제 확인 다이얼로그. 진행 중 등록이 있으면 409 메시지를 토스트로 표출. */
export function DeleteSpeakerDialog({
  open,
  onOpenChange,
  speaker,
}: DeleteSpeakerDialogProps) {
  const del = useDeleteSpeaker();

  function handleDelete() {
    del.mutate(
      { id: speaker.id },
      {
        onSuccess: () => {
          toast({ title: "화자를 삭제했어요.", variant: "success" });
          onOpenChange(false);
        },
        onError: (error) => {
          // 409(진행 중 등록) 등 서버 메시지를 그대로 표출하고 다이얼로그는 유지.
          if (isDemoBlocked(error)) return;
          toast({
            title: "화자 삭제 실패",
            description: toErrorMessage(error),
            variant: "error",
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>화자를 삭제할까요?</DialogTitle>
          <DialogDescription>
            <strong className="font-medium text-foreground">
              {speaker.name}
            </strong>{" "}
            화자를 삭제하면 이 화자로 지정된 발언의 화자 지정이 해제됩니다. 이
            작업은 되돌릴 수 없어요.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">취소</Button>
          </DialogClose>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={handleDelete}
          >
            삭제
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
