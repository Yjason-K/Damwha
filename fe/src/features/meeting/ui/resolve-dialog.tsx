import * as React from "react";

import { isApiError } from "@/shared/api/client";
import { Avatar } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
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
 * 각 행은 이미 등록된 화자를 고르거나 새 이름을 입력해 연결(resolve)한다.
 *
 * 워커는 두 단계로 판단한다. 점수가 자동 연결 문턱을 넘으면 클러스터가 곧바로 그
 * 화자에 묶여 여기 나타나지 않는다. 그 아래 제안 구간에 걸리면 클러스터는 자기
 * 화자를 유지한 채 후보만 달고 오고, 그 판단을 여기서 사람이 내린다 — 후보를 미리
 * 골라두고 왜 골랐는지 밝히되, 연결 자체는 사용자가 누를 때만 일어난다.
 */

const NEW_SPEAKER = "__new__";

/** resolvedSpeakerId가 없거나 provisional인 클러스터만 확인 대상. */
function unresolvedClusters(meeting: Meeting): ClusterInfo[] {
  return meeting.clusters.filter(
    (c) => c.resolvedSpeakerId == null || c.speakerStatus === "provisional",
  );
}

/** 코사인 유사도 원값을 읽기 쉬운 퍼센트로. 확률이 아니라 닮은 정도다. */
function formatSimilarity(similarity: number | null): string {
  return similarity == null ? "—" : `${Math.round(similarity * 100)}%`;
}

function ResolveRow({
  meetingId,
  cluster,
  named,
  auto,
}: {
  meetingId: string;
  cluster: ClusterInfo;
  named: SpeakerItem[];
  auto: SpeakerItem[];
}) {
  const resolve = useResolveCluster();
  // 제안이 있으면 그 화자를 미리 골라둔다 — 확인이 한 번의 클릭으로 끝나게.
  // 자동 적용은 아니다. 아래 힌트 줄이 왜 골라졌는지 밝히고, 연결은 사용자가 누른다.
  const [choice, setChoice] = React.useState(cluster.suggestedSpeakerId ?? "");
  const [newName, setNewName] = React.useState("");

  const k = ((cluster.spk - 1) % 8) + 1;
  const label = cluster.speakerName ?? `화자 ${cluster.spk}`;
  const isNew = choice === NEW_SPEAKER;
  const canSubmit = isNew ? newName.trim().length > 0 : choice.length > 0;
  const hintId = `resolve-hint-${cluster.id}`;
  const hasHint = cluster.suggestedSpeakerId != null;

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
            <SelectTrigger
              size="sm"
              className="w-[148px] shrink-0"
              aria-describedby={hasHint ? hintId : undefined}
            >
              <SelectValue placeholder="화자 선택" />
            </SelectTrigger>
            <SelectContent>
              {named.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
              {named.length > 0 && auto.length > 0 ? <SelectSeparator /> : null}
              {auto.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
              {named.length + auto.length > 0 ? <SelectSeparator /> : null}
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
        {hasHint ? (
          <p
            id={hintId}
            className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--text-secondary)]"
          >
            <Badge variant="accent">추천</Badge>
            목소리가 비슷해요 · 유사도{" "}
            {formatSimilarity(cluster.suggestedSimilarity)}
          </p>
        ) : null}
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
  // 고를 수 있는 화자는 등록이 끝난 것 전부다 — 이름을 붙인 ready와, 파이프라인이
  // 다른 대화에서 자동으로 만든 provisional. provisional을 빼면 신규 설치는 ready가
  // 0명이라 목록이 통째로 비고, 같은 사람을 회의 간에 이어붙일 방법 자체가 사라진다.
  // (pending/failed는 성문이 아직 없거나 실패한 상태라 제외.)
  const settled = (speakers ?? []).filter(
    (s) => s.status === "ready" || s.status === "provisional",
  );
  const named = settled.filter((s) => s.status === "ready");
  const auto = settled.filter((s) => s.status === "provisional");
  const clusters = unresolvedClusters(meeting);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>화자 확인</DialogTitle>
          <DialogDescription>
            성문으로 자동 연결하지 못한 화자예요. 이미 등록된 화자를 고르거나 새
            이름을 입력해 연결하세요.
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
                <ResolveRow
                  meetingId={meeting.id}
                  cluster={c}
                  // 자기 자신으로의 연결은 아무 일도 하지 않으므로 목록에서 뺀다.
                  named={named.filter((s) => s.id !== c.resolvedSpeakerId)}
                  auto={auto.filter((s) => s.id !== c.resolvedSpeakerId)}
                />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
