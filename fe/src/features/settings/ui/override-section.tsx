import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

import { useProcessingSettings } from "../api/settings";
import type {
  PresetName,
  ProcessingOverride,
  SummaryModel,
} from "../api/types";
import {
  deviceSummary,
  PRESET_META,
  PRESET_ORDER,
  SUMMARY_MODEL_OPTIONS,
} from "../lib/presets";

/**
 * OverrideSection — "이번 작업만 다른 설정" 접힌 섹션. 업로드/재처리
 * dialog 공용. 열림 + 프리셋 선택 → onChange(override); 닫으면
 * onChange(undefined) (전역 설정 사용). 노출 범위는 프리셋 + 요약 모델
 * 두 노브다. 나머지 개별 노브(whisper/devices/language)는 서버 계약상
 * 가능하지만 UI에 두지 않는다 — 결과를 custom으로 만들어 혼동 여지가
 * 크다. 요약 모델은 예외로, "이번만 큰 모델로" 요구가 명확해 노출한다
 * (서버는 이 경우에도 결과를 custom으로 기록한다).
 * 프리셋 목록은 의도적으로 gpu_eligible로 게이팅하지 않는다 — 제품이 Apple
 * Silicon 전용이라 비적격 환경은 미지원이며, 그 경우 서버 400을 토스트로
 * 그레이스풀 처리한다(전역 설정 폼의 보수적 게이팅이 1차 방어).
 */

type OverrideSectionProps = {
  value: ProcessingOverride | undefined;
  onChange: (value: ProcessingOverride | undefined) => void;
};

export function OverrideSection({ value, onChange }: OverrideSectionProps) {
  const [open, setOpen] = React.useState(value !== undefined);
  const { data: global } = useProcessingSettings();

  // 부모 reset(value → undefined) 시 섹션 닫힘 동기화. 사용자가 섹션만 열고
  // 아직 선택 전인 상태(open && value undefined)는 value 변화가 없어 영향 없음.
  // 외부 prop을 내부 open 상태에 동기화하는 의도된 effect라 set-state-in-effect
  // 규칙을 해제한다(1회성, cascading 아님).
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (value === undefined) setOpen(false);
  }, [value]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next) onChange(undefined);
  };

  // 서버는 override.preset을 먼저 resolve한 뒤 개별 필드를 덮어쓴다(요약 모델을
  // 비워두면 프리셋의 기본값이 적용됨) — 플레이스홀더가 그 실제 기본값을
  // 가리키게 한다. 프리셋 미선택 시에만 전역 설정이 기본값이다.
  const summaryModelPlaceholder = value?.preset
    ? `요약 모델 (기본: ${PRESET_META[value.preset].summary_model})`
    : "요약 모델 (기본: 전역 설정)";

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="self-start text-sm font-medium text-[color:var(--accent-text)] outline-none focus-visible:[box-shadow:var(--focus-ring)]"
      >
        이번 작업만 다른 설정 {open ? "사용 안 함" : "사용"}
      </button>

      {open && (
        <div className="flex flex-col gap-2 rounded-md border border-[color:var(--border-subtle)] p-3">
          <span className="text-xs text-[color:var(--text-muted)]">
            현재 전역:{" "}
            {global
              ? `${global.whisper_model} · ${deviceSummary(global.devices)} · 요약 ${global.summary_model}`
              : "불러오는 중…"}
          </span>
          <Select
            value={value?.preset}
            onValueChange={(v) =>
              onChange({ ...value, preset: v as PresetName })
            }
          >
            <SelectTrigger aria-label="이번 작업 프리셋">
              <SelectValue placeholder="프리셋 선택" />
            </SelectTrigger>
            <SelectContent>
              {PRESET_ORDER.map((name) => (
                <SelectItem key={name} value={name}>
                  {PRESET_META[name].label} — {PRESET_META[name].whisper_model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={value?.summary_model}
            onValueChange={(v) =>
              onChange({ ...value, summary_model: v as SummaryModel })
            }
          >
            <SelectTrigger aria-label="이번 작업 요약 모델">
              <SelectValue placeholder={summaryModelPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {SUMMARY_MODEL_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-2xs text-[color:var(--text-faint)]">
            이 설정은 저장되지 않고 이번 작업에만 적용돼요.
          </span>
        </div>
      )}
    </div>
  );
}
