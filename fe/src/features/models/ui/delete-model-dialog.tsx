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
import { useDeleteModel } from "../api/models";
import type { ModelRow } from "../api/types";
import { formatBytes } from "../lib/format";

/** 모델 삭제 확인 (스펙 §6.4). 비워질 용량은 그 행의 sizeBytes다. */
export function DeleteModelDialog({
  open,
  onOpenChange,
  row,
  label,
  onError,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  row: ModelRow;
  label: string;
  onError: (e: unknown) => void;
  /** 삭제 성공 시(다이얼로그를 닫기 전) 호출 — 오래된 충돌 문구를 지우는 용도. */
  onSuccess?: () => void;
}) {
  const del = useDeleteModel();
  const freed = row.sizeBytes !== null ? `${formatBytes(row.sizeBytes)}가 비워져요. ` : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>모델 지우기</DialogTitle>
          <DialogDescription>
            {`${label}를 지울까요? ${freed}다시 쓰려면 다시 받아야 해요.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">취소</Button>
          </DialogClose>
          <Button
            variant="danger"
            disabled={del.isPending}
            onClick={() =>
              del.mutate(
                { role: row.role, name: row.name, backend: row.backend },
                {
                  onSuccess: () => {
                    onOpenChange(false);
                    onSuccess?.();
                  },
                  onError: (e) => {
                    onOpenChange(false);
                    onError(e);
                  },
                },
              )
            }
          >
            지우기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
