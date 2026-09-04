import * as React from "react";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
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

import { formatClock } from "../api/mappers";
import { useResolveCluster } from "../api/meetings";
import { cn } from "@/shared/lib/utils";
import { pickSample, type Sample } from "../model/sample";
import type { ClusterInfo, Meeting } from "../model/types";
import { Icon } from "./icons";

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

/** 미디어 프래그먼트 — 브라우저가 start에서 시작해 end에서 스스로 멈춘다. */
function sampleSrc(audioUrl: string, s: Sample): string {
  return `${audioUrl}#t=${s.start},${s.end}`;
}

/**
 * 다이얼로그 안 공용 <audio> 하나로 미리듣기를 돌린다. 한 번에 한 행만 재생되고,
 * 메인 플레이어와는 별개라 본 재생 위치를 건드리지 않는다.
 */
function useSamplePlayer(audioUrl: string) {
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [playingId, setPlayingId] = React.useState<string | null>(null);
  /** 재생 중인 샘플의 시작점 — timeupdate에서 경과 시간을 계산할 기준. */
  const startRef = React.useRef(0);
  const [elapsed, setElapsed] = React.useState(0);

  const stop = React.useCallback(() => {
    audioRef.current?.pause();
    setPlayingId(null);
  }, []);

  const toggle = React.useCallback(
    (id: string, sample: Sample) => {
      const a = audioRef.current;
      if (!a) return;
      if (playingId === id) {
        stop();
        return;
      }
      a.pause();
      a.setAttribute("src", sampleSrc(audioUrl, sample));
      startRef.current = sample.start;
      setElapsed(0);
      setPlayingId(id);
      void a.play().catch(() => setPlayingId(null));
    },
    [audioUrl, playingId, stop],
  );

  const element = (
    <audio
      ref={audioRef}
      preload="none"
      onTimeUpdate={(e) =>
        setElapsed(Math.max(0, e.currentTarget.currentTime - startRef.current))
      }
      onPause={() => setPlayingId(null)}
      onEnded={() => setPlayingId(null)}
    />
  );

  return { element, playingId, elapsed, toggle, stop };
}

/**
 * SampleRow — 카드 안의 독립된 "듣기" 단계. row 전체가 버튼이라 클릭 영역이 넓고,
 * 라벨·길이·진행 상태를 같이 보여 "무엇을 재생하는지"를 설명한다.
 */
function SampleRow({
  sample,
  playing,
  elapsed,
  spk,
  onToggle,
}: {
  sample: Sample;
  playing: boolean;
  elapsed: number;
  spk: number;
  onToggle: () => void;
}) {
  const k = ((spk - 1) % 8) + 1;
  const length = sample.end - sample.start;
  const clamped = Math.min(elapsed, length);
  const pct = length > 0 ? Math.round((clamped / length) * 100) : 0;
  const total = formatClock(length * 1000);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={playing}
      className={cn(
        "group flex w-full cursor-pointer flex-col gap-1.5 rounded-sm border px-2 py-1.5 text-left outline-none transition-[background-color,border-color,box-shadow] duration-[80ms] focus-visible:[box-shadow:var(--focus-ring)]",
        playing
          ? "border-[color:var(--border-strong)] bg-[var(--gray-2)]"
          : "border-transparent hover:border-border hover:bg-[var(--gray-2)]",
      )}
    >
      <span className="flex items-center gap-2 text-sm">
        <span
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full"
          style={{
            background: `var(--spk-${k}-bg)`,
            color: `var(--spk-${k}-text)`,
          }}
        >
          <Icon name={playing ? "pause" : "play"} size={13} />
        </span>
        <span className="flex-1 font-medium">
          {playing ? "재생 중…" : "샘플 듣기"}
        </span>
        <span className="tabular-nums text-xs text-[color:var(--text-secondary)]">
          {playing ? `${formatClock(clamped * 1000)} / ${total}` : total}
        </span>
      </span>
      {playing ? (
        <span
          role="progressbar"
          aria-label="샘플 재생 진행"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="block h-1 w-full overflow-hidden rounded-full bg-[var(--gray-4)]"
        >
          <span
            className="block h-full rounded-full transition-[width] duration-150"
            style={{ width: `${pct}%`, background: `var(--spk-${k}-text)` }}
          />
        </span>
      ) : null}
    </button>
  );
}

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
  sample,
  playing,
  elapsed,
  onToggleSample,
}: {
  meetingId: string;
  cluster: ClusterInfo;
  named: SpeakerItem[];
  auto: SpeakerItem[];
  sample: Sample | null;
  playing: boolean;
  elapsed: number;
  onToggleSample: (sample: Sample) => void;
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
        onError: (err) => {
          if (isDemoBlocked(err)) return;
          toast({
            variant: "error",
            title: "화자 연결에 실패했어요.",
            description: isApiError(err) ? err.message : undefined,
          });
        },
      },
    );
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-card px-3 py-2.5 transition-colors duration-[80ms]",
        playing ? "border-[color:var(--border-strong)]" : "border-border",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Avatar name={label} speaker={cluster.spk} unconfirmed size="md" />
        <div
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          style={{ color: `var(--spk-${k}-text)` }}
        >
          {label}
        </div>
      </div>

      {sample ? (
        <SampleRow
          sample={sample}
          playing={playing}
          elapsed={elapsed}
          spk={cluster.spk}
          onToggle={() => onToggleSample(sample)}
        />
      ) : null}

      {hasHint ? (
        <p
          id={hintId}
          className="flex flex-wrap items-center gap-1.5 px-0.5 text-xs text-[color:var(--text-secondary)]"
        >
          <Badge variant="accent">추천</Badge>
          {cluster.suggestedSpeakerName ? (
            <span className="font-medium text-foreground">
              {cluster.suggestedSpeakerName}
            </span>
          ) : null}
          목소리가 비슷해요 · 유사도{" "}
          {formatSimilarity(cluster.suggestedSimilarity)}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Select value={choice} onValueChange={setChoice}>
          <SelectTrigger
            size="sm"
            className="w-[168px] shrink-0"
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
        ) : (
          <span className="flex-1" />
        )}
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
  const player = useSamplePlayer(meeting.audioUrl);

  const handleOpenChange = (next: boolean) => {
    if (!next) player.stop();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>화자 확인</DialogTitle>
          <DialogDescription>
            성문으로 자동 연결하지 못한 화자예요. 이미 등록된 화자를 고르거나 새
            이름을 입력해 연결하세요.
          </DialogDescription>
        </DialogHeader>
        {player.element}
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
                  sample={pickSample(meeting, c.spk)}
                  playing={player.playingId === c.id}
                  elapsed={player.elapsed}
                  onToggleSample={(s) => player.toggle(c.id, s)}
                />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
