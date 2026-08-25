import * as React from "react";

import { Input } from "@/shared/ui/input";

import type { SpeakerBounds } from "../api/types";
import { isSpeakerBoundsValid, SPEAKER_BOUND_MAX } from "../lib/speaker-bounds";

/**
 * SpeakerCountField — 회의 참석자 수 힌트(최소~최대). 업로드/재처리 dialog 공용.
 * 서버는 이 범위를 pyannote의 min/max_speakers로 넘겨 클러스터 수 추정을 제한한다 —
 * 한 사람이 여러 화자로 쪼개지거나(과분할) 둘이 하나로 합쳐지는(과소분할) 걸 막는
 * 가장 싼 수단이다. 처리 설정 오버라이드와 무관하고 preset을 custom으로 바꾸지 않는다.
 *
 * 두 칸 다 비면 onChange(undefined) — 자동 추정. 정확히 알면 같은 값을 넣는다.
 * 뒤집힌 범위(min > max)는 여기서 에러를 보이고, 부모는 `isSpeakerBoundsValid`로
 * 제출을 막는다. 서버도 같은 규칙으로 400을 내지만 왕복 전에 잡는다.
 */

type SpeakerCountFieldProps = {
  value: SpeakerBounds | undefined;
  onChange: (value: SpeakerBounds | undefined) => void;
};

function parseBound(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= SPEAKER_BOUND_MAX
    ? n
    : undefined;
}

export function SpeakerCountField({ value, onChange }: SpeakerCountFieldProps) {
  const labelId = React.useId();
  const hintId = React.useId();
  const errorId = React.useId();
  const invalid = !isSpeakerBoundsValid(value);

  const update = (key: "min" | "max", raw: string) => {
    const next = { ...(value ?? {}), [key]: parseBound(raw) };
    if (next.min === undefined) delete next.min;
    if (next.max === undefined) delete next.max;
    onChange(
      next.min === undefined && next.max === undefined ? undefined : next,
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span
        id={labelId}
        className="text-sm font-medium text-[color:var(--text-secondary)]"
      >
        참석자 수 (선택)
      </span>
      <p id={hintId} className="text-sm text-[color:var(--text-muted)]">
        알고 있으면 화자 분리가 훨씬 정확해져요. 정확히 알면 같은 값을, 한마디만
        한 사람은 빼고 세요.
      </p>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
        className="flex items-center gap-2"
      >
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={SPEAKER_BOUND_MAX}
          step={1}
          placeholder="최소"
          aria-label="최소 화자 수"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : hintId}
          value={value?.min ?? ""}
          onChange={(e) => update("min", e.target.value)}
          containerClassName="w-[96px] shrink-0"
        />
        <span className="text-sm text-[color:var(--text-muted)]" aria-hidden>
          ~
        </span>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={SPEAKER_BOUND_MAX}
          step={1}
          placeholder="최대"
          aria-label="최대 화자 수"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : hintId}
          value={value?.max ?? ""}
          onChange={(e) => update("max", e.target.value)}
          containerClassName="w-[96px] shrink-0"
        />
      </div>
      {invalid ? (
        <p
          id={errorId}
          role="alert"
          className="text-sm text-[color:var(--red-text)]"
        >
          최소가 최대보다 클 수 없어요.
        </p>
      ) : null}
    </div>
  );
}
