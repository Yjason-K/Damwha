import * as React from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { Button } from "@/shared/ui/button";
import { useToast } from "@/shared/ui/use-toast";

import {
  useRetryExtraction,
  useSetLensCompletion,
} from "@/features/lens/api/lenses";
import { useMeetingLenses } from "@/features/meeting/api/lenses";
import { formatClock, mapMeetingLenses } from "@/features/meeting/api/mappers";
import {
  useGenerateSummary,
  useMeeting,
  useMeetingStatus,
  useReindexMeeting,
  useSyncSummaryStatus,
} from "@/features/meeting/api/meetings";
import type {
  MeetingStatusResponse,
  SearchIndexStatus,
} from "@/features/meeting/api/types";
import type { Meeting } from "@/features/meeting/model/types";
import { CenterState, Spinner } from "@/features/meeting/ui/center-state";
import { Icon } from "@/features/meeting/ui/icons";
import { InsightPane } from "@/features/meeting/ui/insight-pane";
import { PlayerBar } from "@/features/meeting/ui/player-bar";
import { TranscriptPane } from "@/features/meeting/ui/transcript-pane";
import { useProcessingSettings } from "@/features/settings/api/settings";
import type { SummaryModel } from "@/features/settings/api/types";

/**
 * `/meetings/:meetingId` — 셸(AppShell) 안의 회의 뷰. 전사 + 인사이트 + 실제
 * 오디오 플레이어를 그리고, 하이라이트할 발언은 `?u=` 쿼리로 받는다.
 */

/** 처리 단계(stage) → 한국어 표기. */
const STAGE_LABELS: Record<string, string> = {
  vad: "음성 구간 감지",
  diarize: "화자 분리",
  identify: "화자 식별",
  stt: "받아쓰기",
  align: "정렬",
  persist: "저장",
  embed: "색인",
};

function ProcessingBanner({
  meeting,
  status,
}: {
  meeting: Meeting;
  status: MeetingStatusResponse | undefined;
}) {
  if (meeting.status === "failed") {
    return (
      <div
        role="alert"
        className="flex items-center gap-2.5 border-b border-[color:var(--red-6)] bg-[var(--red-bg)] px-7 py-2.5 text-sm"
      >
        <Icon
          name="clock"
          size={15}
          className="shrink-0 text-[color:var(--red-text)]"
        />
        <span className="font-semibold text-[color:var(--red-text)]">
          처리에 실패했어요
        </span>
        <span className="text-[color:var(--text-secondary)]">
          다시 업로드하거나 잠시 후 시도해 주세요.
        </span>
      </div>
    );
  }

  const stageLabel = status?.stage
    ? (STAGE_LABELS[status.stage] ?? "처리 중")
    : "대기 중";
  const raw = status?.progress ?? null;
  const pct = raw == null ? null : Math.round(raw <= 1 ? raw * 100 : raw);

  return (
    <div
      role="status"
      aria-busy="true"
      className="flex items-center gap-2.5 border-b border-[color:var(--accent-6)] bg-[var(--accent-1)] px-7 py-2.5 text-sm"
    >
      <span
        aria-hidden="true"
        className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-[color:var(--accent-solid)] border-r-transparent"
      />
      <span className="font-semibold text-[color:var(--accent-text)]">
        회의를 처리하고 있어요
      </span>
      <span className="text-[color:var(--text-secondary)]">
        {stageLabel}
        {pct != null ? ` · ${pct}%` : ""}
      </span>
    </div>
  );
}

/**
 * 색인 실패 배너 — 회의 처리(done)는 끝났지만 검색 색인 job이 실패한 상태.
 * 회의 열람은 문제없고 검색에서만 빠지므로 ProcessingBanner와 분리해 그린다.
 * 원본 에러는 워커 로그 덤프라 길다 — 본문에는 안내 문구만 쓰고 message는
 * title(hover)로만 노출한다.
 */
function IndexFailedBanner({
  meetingId,
  searchIndex,
}: {
  meetingId: string;
  searchIndex: SearchIndexStatus;
}) {
  const reindex = useReindexMeeting();
  return (
    <div
      role="alert"
      className="flex items-center gap-2.5 border-b border-[color:var(--red-6)] bg-[var(--red-bg)] px-7 py-2.5 text-sm"
    >
      <Icon
        name="search"
        size={15}
        className="shrink-0 text-[color:var(--red-text)]"
      />
      <span className="font-semibold text-[color:var(--red-text)]">
        검색 색인에 실패했어요
      </span>
      <span
        className="min-w-0 truncate text-[color:var(--text-secondary)]"
        title={searchIndex.error?.message}
      >
        이 회의가 검색 결과에 나오지 않을 수 있어요.
        {searchIndex.error?.code ? ` (${searchIndex.error.code})` : ""}
      </span>
      <Button
        variant="secondary"
        size="sm"
        className="ml-auto shrink-0"
        disabled={reindex.isPending}
        onClick={() => reindex.mutate(meetingId)}
      >
        다시 색인
      </Button>
    </div>
  );
}

/**
 * 회의 뷰의 라우트 엘리먼트. `MeetingView`는 회의마다 리마운트되므로(key),
 * 리마운트를 건너 살아 있어야 하는 상태는 이 부모가 소유한다 — 회의를 오갈 때
 * 되살아나면 안 되는 것(AI 안내 배너 확인)과, 반대로 회의를 바꿔도 이어져야
 * 하는 것(재생 배속: 전사를 훑는 동안 유지되는 작업 모드다) 둘 다.
 */
export function MeetingRoute() {
  const { meetingId = "" } = useParams();
  const [aiAck, setAiAck] = React.useState<Record<string, boolean>>({});
  const [speed, setSpeed] = React.useState(1);

  return (
    <MeetingView
      key={meetingId}
      meetingId={meetingId}
      aiAcked={!!aiAck[meetingId]}
      onAckAi={() => setAiAck((a) => ({ ...a, [meetingId]: true }))}
      speed={speed}
      onSpeed={setSpeed}
    />
  );
}

type MeetingViewProps = {
  meetingId: string;
  aiAcked: boolean;
  onAckAi: () => void;
  speed: number;
  onSpeed: (speed: number) => void;
};

function MeetingView({
  meetingId,
  aiAcked,
  onAckAi,
  speed,
  onSpeed,
}: MeetingViewProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeId = searchParams.get("u") ?? "";

  const [tab, setTab] = React.useState("summary");
  const [playing, setPlaying] = React.useState(false);
  const [pos, setPos] = React.useState(0);
  const [audioDuration, setAudioDuration] = React.useState(0);
  const [metaReady, setMetaReady] = React.useState(false);

  const audioRef = React.useRef<HTMLAudioElement>(null);

  const {
    data: meeting,
    isError: meetingError,
    isFetching: meetingFetching,
    refetch: refetchMeeting,
  } = useMeeting(meetingId);

  // <audio>는 status를 key로 리마운트된다(아래 JSX 참고). 새 엘리먼트는 아직
  // 메타데이터가 없으므로 준비 상태도 함께 되돌려, 배속·seek effect가 새
  // 엘리먼트의 loadedmetadata 뒤에 다시 돌게 한다.
  const meetingStatus = meeting?.status;
  React.useEffect(() => {
    // 리마운트에 맞춰 준비 상태를 초기화하는 의도된 effect다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMetaReady(false);
    setPlaying(false);
  }, [meetingStatus]);

  const { data: meetingLensData } = useMeetingLenses(meetingId);
  const setLensCompletion = useSetLensCompletion();
  const extractLenses = useRetryExtraction();
  const generateSummary = useGenerateSummary();
  const processingSettings = useProcessingSettings();
  const [summaryModel, setSummaryModel] = React.useState<
    SummaryModel | undefined
  >(undefined);
  // 선택 전 기본값은 전역 설정값 — 서버도 body가 없으면 같은 값을 쓴다.
  const effectiveSummaryModel =
    summaryModel ?? processingSettings.data?.summary_model;
  const meetingLenses = React.useMemo(
    () =>
      meeting
        ? mapMeetingLenses(meetingLensData?.items ?? [], meeting.speakers)
        : {},
    [meetingLensData, meeting],
  );

  const summaryPending =
    meeting?.summaryStatus === "queued" ||
    meeting?.summaryStatus === "running" ||
    generateSummary.isPending;

  // done 회의도 색인 실패를 봐야 하므로 meeting이 있으면 조회한다 —
  // 폴링 지속 여부는 useMeetingStatus의 refetchInterval이 상태를 보고 결정.
  const statusEnabled = !!meeting || summaryPending;
  const { data: procStatus } = useMeetingStatus(meetingId, statusEnabled);

  useSyncSummaryStatus(
    meetingId,
    meeting?.summaryStatus,
    procStatus?.summary?.status,
  );

  const { toast } = useToast();

  // Real audio transport: keep the element in sync with speed / play state.
  // metaReady를 deps에 두는 이유: 첫 렌더에는 meeting이 없어 <audio>도 없고,
  // 배속은 회의를 건너 유지되므로(부모 소유) 1×가 아닌 값으로 새 회의에 들어올
  // 수 있다. speed만 보면 값이 그대로라 effect가 다시 돌지 않아 새 엘리먼트에
  // 반영되지 않는다 — 엘리먼트가 준비되는 시점을 뜻하는 metaReady가 뒤집힐 때
  // 한 번 더 돌게 한다.
  React.useEffect(() => {
    const a = audioRef.current;
    if (a) a.playbackRate = speed;
  }, [speed, metaReady]);

  React.useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.play().catch(() => setPlaying(false));
    else a.pause();
  }, [playing]);

  // 매핑된 duration이 없으면(=null → 0) 실제 <audio>의 loadedmetadata duration으로
  // 대체해, duration_ms가 null인 회의도 플레이어를 렌더할 수 있게 한다.
  const mappedTotal = meeting?.totalSeconds ?? 0;
  const totalSeconds = mappedTotal > 0 ? mappedTotal : audioDuration;

  const seek = (fraction: number) => {
    const a = audioRef.current;
    const total =
      a && Number.isFinite(a.duration) && a.duration > 0
        ? a.duration
        : totalSeconds;
    if (a && total > 0) a.currentTime = fraction * total;
    setPos(fraction);
  };

  // 하이라이트 대상 발언의 시작 시각. 폴링 재조회로 meeting 객체가 새로 와도
  // 값이 같으면 identity가 유지되어 아래 effect가 헛돌지 않는다.
  const targetStartMs = React.useMemo(() => {
    if (!activeId || !meeting) return null;
    const source = meeting.utterances
      .flatMap((x) => x.sources)
      .find((s) => s.id === activeId);
    return source ? source.startMs : null;
  }, [activeId, meeting]);

  // seek은 오디오 준비 여부와 대상 시각이 모두 갖춰졌을 때 판정한다. 이미 열린
  // 회의에서 `?u=`만 바뀌는 경로(검색·전사 클릭)는 오디오가 재로드되지 않으므로
  // onLoadedMetadata만으로는 놓친다.
  React.useEffect(() => {
    if (targetStartMs == null || !metaReady || totalSeconds <= 0) return;
    const fraction = Math.min(1, targetStartMs / 1000 / totalSeconds);
    const a = audioRef.current;
    if (a) a.currentTime = fraction * totalSeconds;
    // 외부 신호(?u=)를 재생 위치에 반영하는 의도된 effect다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos(fraction);
  }, [targetStartMs, metaReady, totalSeconds]);

  // historical 가드: 재처리 등으로 회의가 로드된 뒤에도 `?u=`가 가리키는
  // 발언(원본 발화 id 포함)을 찾을 수 없으면 안내 토스트를 띄우고 u를 없앤다.
  // 캐시된 meeting이 stale한 채 백그라운드 재조회가 진행 중일 때 false
  // negative(아직 갱신 전 데이터로 오판)를 막기 위해 isFetching이 꺼졌을 때만
  // 판정한다. 히스토리에 남기면 뒤로가기로 무효한 u가 되살아나 토스트가
  // 반복되므로 replace로 지운다.
  React.useEffect(() => {
    if (!activeId || !meeting || meetingFetching) return;
    const found = meeting.utterances.some(
      (u) => u.id === activeId || u.sources.some((s) => s.id === activeId),
    );
    if (!found) {
      toast({
        description: "재처리로 근거 발언을 현재 버전에서 찾을 수 없어요.",
      });
      setSearchParams({}, { replace: true });
    }
  }, [activeId, meeting, meetingFetching, toast, setSearchParams]);

  // 회의 안에서의 발언 점프. 두 가지를 함께 처리한다.
  // 1) 이미 활성인 발언을 다시 누르면 `?u=`가 그대로라 위 seek effect의 deps가
  //    바뀌지 않아 아무 일도 일어나지 않는다. "여기서 다시 듣기"가 죽지 않도록
  //    이 경우만 재생 위치를 직접 옮긴다(리렌더 없이 오디오만 건드린다).
  // 2) 새 발언으로의 이동은 replace다. 하이라이트는 회의 안의 일시적 상태라
  //    히스토리 단위가 아니고, push하면 점프 횟수만큼 뒤로가기를 눌러야 회의를
  //    벗어난다(같은 URL이 쌓여 뒤로가기가 고장 난 것처럼 보인다).
  const jumpTo = (uid: string) => {
    if (uid === activeId) {
      if (targetStartMs != null && totalSeconds > 0)
        seek(Math.min(1, targetStartMs / 1000 / totalSeconds));
      return;
    }
    setSearchParams({ u: uid }, { replace: true });
  };

  const handleDeleted = () => {
    navigate("/", { replace: true });
  };

  const renderCenter = () => {
    // 렌더 가능한 상세가 있으면 최우선으로 그린다 — 배경 재조회 실패가 렌더 가능한
    // 전사를 에러 화면으로 덮지 않도록. 그 다음이 에러, 마지막이 로딩.
    if (!meeting) {
      if (meetingError) {
        return (
          <CenterState>
            <Icon
              name="inbox"
              size={22}
              className="text-[color:var(--text-faint)]"
            />
            <p className="text-sm text-[color:var(--text-muted)]">
              회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => refetchMeeting()}
            >
              다시 시도
            </Button>
          </CenterState>
        );
      }
      return (
        <CenterState busy>
          <Spinner />
          <p className="text-sm text-[color:var(--text-muted)]">
            회의를 불러오는 중…
          </p>
        </CenterState>
      );
    }
    return (
      <>
        <TranscriptPane
          meeting={meeting}
          activeId={activeId}
          onJump={jumpTo}
          onDeleted={handleDeleted}
          aiAcked={aiAcked}
          onAckAi={onAckAi}
          onShowSummary={() => setTab("summary")}
        />
        <InsightPane
          meeting={meeting}
          lenses={meetingLenses}
          tab={tab}
          onTab={setTab}
          onToggle={(id, doneVal) =>
            setLensCompletion.mutate({ id, done: doneVal })
          }
          onOpenLens={(k) => navigate(`/lenses/${k}`)}
          onJumpSegment={jumpTo}
          onRegenerateSummary={() =>
            generateSummary.mutate({
              id: meeting.id,
              summary_model: effectiveSummaryModel,
            })
          }
          summaryModel={effectiveSummaryModel}
          onSummaryModelChange={setSummaryModel}
          regenerating={generateSummary.isPending}
          lensExtractionStatus={meetingLensData?.extractionStatus ?? null}
          onExtractLenses={() => extractLenses.mutate(meeting.id)}
          extracting={extractLenses.isPending}
        />
      </>
    );
  };

  return (
    <>
      <div className="col-start-2 flex min-w-0 flex-col">
        {meeting && meeting.status !== "done" ? (
          <ProcessingBanner meeting={meeting} status={procStatus} />
        ) : null}
        {meeting &&
        meeting.status === "done" &&
        procStatus?.search_index?.status === "failed" ? (
          <IndexFailedBanner
            meetingId={meeting.id}
            searchIndex={procStatus.search_index}
          />
        ) : null}
        <div className="flex min-h-0 flex-1">{renderCenter()}</div>
      </div>

      {/* 타임라인에 그릴 화자 레인이 없으면(업로드/처리 중, 전사 없는 실패)
          플레이바를 숨긴다 — 점프할 대상이 없는 빈 눈금자만 남기 때문이다.
          status가 아니라 tracks로 판정해야 재처리 실패로 status는 failed지만
          이전 전사가 남아 있는 회의에서 재생이 사라지지 않는다. */}
      {meeting && meeting.tracks.length > 0 && totalSeconds > 0 ? (
        <PlayerBar
          className="col-span-2"
          tracks={meeting.tracks}
          playing={playing}
          pos={pos}
          totalSeconds={totalSeconds}
          durLabel={
            mappedTotal > 0 ? meeting.dur : formatClock(totalSeconds * 1000)
          }
          speed={speed}
          onSpeed={onSpeed}
          onToggle={() => setPlaying((p) => !p)}
          onSeek={seek}
        />
      ) : null}

      {meeting ? (
        // key에 status를 두는 이유: /audio URL은 회의 내내 같지만, 워커가
        // normalized.flac을 쓰고 나면 그 URL이 다른 파일(크기·타입 모두)을
        // 내려준다. 업로드 직후 원본 기준으로 붙은 <audio>는 src가 그대로라
        // 재로드하지 않아 완료 후 재생이 안 되고, 새로고침해야만 살아났다.
        // 상태 전이마다 엘리먼트를 새로 만들어 강제로 다시 로드한다.
        <audio
          key={meeting.status}
          ref={audioRef}
          src={meeting.audioUrl}
          preload="metadata"
          className="hidden"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setAudioDuration(d);
            setMetaReady(true);
          }}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            const total =
              Number.isFinite(a.duration) && a.duration > 0
                ? a.duration
                : totalSeconds;
            if (total > 0) setPos(Math.min(1, a.currentTime / total));
          }}
          onEnded={() => setPlaying(false)}
        />
      ) : null}
    </>
  );
}
