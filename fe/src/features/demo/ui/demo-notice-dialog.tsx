import { useState } from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

export const DEMO_NOTICE_STORAGE_KEY = "damwha.demo-notice.v1";

function alreadySeen(): boolean {
  try {
    return localStorage.getItem(DEMO_NOTICE_STORAGE_KEY) !== null;
  } catch {
    return false; // 저장소를 못 읽으면(사생활 모드 등) 안내를 한 번 더 보이는 쪽이 안전
  }
}

function markSeen() {
  try {
    localStorage.setItem(DEMO_NOTICE_STORAGE_KEY, new Date().toISOString());
  } catch {
    /* 저장 실패는 다음 방문에 다시 보이는 것뿐 */
  }
}

/**
 * 공개 데모 첫 방문 안내(설계 §3.6). 데모 빌드에서만 providers가 lazy로 붙인다.
 * 내용은 §1의 정직성 항목 — 읽기 전용 / NotebookLM 생성 샘플 / 업로드가 없는 이유.
 */
export function DemoNoticeDialog() {
  const [open, setOpen] = useState(() => !alreadySeen());

  function close() {
    markSeen();
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Damwha 공개 데모</DialogTitle>
          <DialogDescription>
            미리 처리해 둔 회의의 결과만 확인할 수 있는 읽기 전용 데모입니다.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2 text-sm leading-normal text-[color:var(--text-secondary)]">
          <li>
            회의 오디오는 Google NotebookLM이 주제를 받아 생성한{" "}
            <strong className="font-medium text-foreground">AI 대화 샘플</strong>이에요.
            실제 인물의 음성이 아닙니다.
          </li>
          <li>
            전사·화자 분리·렌즈·요약은 이 샘플을 개발자의 Mac에서 실제 파이프라인으로
            처리한 결과 그대로입니다.
          </li>
          <li>
            업로드와 편집은 막혀 있어요. 음성 처리 파이프라인이 Apple Silicon(MLX) 로컬
            실행 전용이라 클라우드에 워커를 두지 않았기 때문입니다.
          </li>
        </ul>
        <DialogFooter>
          <Button onClick={close}>확인</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
