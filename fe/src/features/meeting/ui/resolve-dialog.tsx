import * as React from "react";

import { isApiError } from "@/shared/api/client";
import { Avatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { toast } from "@/shared/ui/use-toast";
import { useSpeakers, type SpeakerItem } from "@/features/speaker/api/speakers";

import { useResolveCluster } from "../api/meetings";
import type { ClusterInfo, Meeting } from "../model/types";

/**
 * ResolveDialog — 성문으로 자동 연결하지 못한 화자(미해결 클러스터)를 확인한다.
 * 각 행은 기존 ready 화자를 고르거나 새 이름을 입력해 연결(resolve)한다. Ported
 * flow: 기존 mock settle() 대신 실 클러스터 resolve API에 대응.
 */

const NEW_SPEAKER = "__new__";

/** resolvedSpeakerId가 없거나 provisional인 클러스터만 확인 대상. */
function unresolvedClusters(meeting: Meeting): ClusterInfo[] {
  return meeting.clusters.filter(
    (c) => c.resolvedSpeakerId == null || c.speakerStatus === "provisional",
  );
}

function ResolveRow({
  meetingId,
  cluster,
  ready,
}: {
  meetingId: string;
  cluster: ClusterInfo;
  ready: SpeakerItem[];
}) {
  const resolve = useResolveCluster();
  const [choice, setChoice] = React.useState("");
  const [newName, setNewName] = React.useState("");

  const k = ((cluster.spk - 1) % 8) + 1;
  const label = cluster.speakerName ?? `화자 ${cluster.spk}`;
  const isNew = choice === NEW_SPEAKER;
  const canSubmit = isNew ? newName.trim().length > 0 : choice.length > 0;

  const submit = () => {
    const body = isNew ? { new_name: newName.trim() } : { speaker_id: choice };
    resolve.mutate(
      { meetingId, clusterId: cluster.id, body },
      {
        onSuccess: () =>
          toast({ variant: "success", title: `${label} 화자를 연결했어요.` }),
        onError: (err) =>
          toast({
            variant: "error",
            title: "화자 연결에 실패했어요.",
            description: isApiError(err) ? err.message : undefined,
          }),
      },
    );
  };

  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2.5">
      <Avatar name={label} speaker={cluster.spk} unconfirmed size="md" />
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm font-semibold"
          style={{ color: `var(--spk-${k}-text)` }}
        >
          {label}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger size="sm" className="w-[148px] shrink-0">
              <SelectValue placeholder="화자 선택" />
            </SelectTrigger>
            <SelectContent>
              {ready.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
              {ready.length > 0 ? <SelectSeparator /> : null}
              <SelectItem value={NEW_SPEAKER}>+ 새 화자로 등록</SelectItem>
            </SelectContent>
          </Select>
          {isNew ? (
            <Input
              inputSize="sm"
              aria-label="새 화자 이름"
              placeholder="이름 입력"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              containerClassName="min-w-0 flex-1"
            />
          ) : null}
        </div>
      </div>
      <Button
        size="sm"
        onClick={submit}
        loading={resolve.isPending}
        disabled={!canSubmit}
        className="shrink-0"
      >
        연결
      </Button>
    </div>
  );
}

type ResolveDialogProps = {
  meeting: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ResolveDialog({
  meeting,
  open,
  onOpenChange,
}: ResolveDialogProps) {
  const { data: speakers } = useSpeakers();
  const ready = (speakers ?? []).filter((s) => s.status === "ready");
  const clusters = unresolvedClusters(meeting);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>화자 확인</DialogTitle>
          <DialogDescription>
            성문으로 자동 연결하지 못한 화자예요. 기존 화자를 고르거나 새 이름을
            입력해 연결하세요.
          </DialogDescription>
        </DialogHeader>
        {clusters.length === 0 ? (
          <p className="py-6 text-center text-sm text-[color:var(--text-muted)]">
            확인이 필요한 화자가 없어요.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {clusters.map((c) => (
              <li key={c.id}>
                <ResolveRow meetingId={meeting.id} cluster={c} ready={ready} />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
