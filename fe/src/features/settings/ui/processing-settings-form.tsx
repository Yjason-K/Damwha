import * as React from "react";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { isApiError } from "@/shared/api/client";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import { toast } from "@/shared/ui/use-toast";
import { cn } from "@/shared/lib/utils";

import {
  useCapabilities,
  useProcessingSettings,
  useUpdateProcessingSettings,
} from "../api/settings";
import type {
  Device,
  PresetName,
  ProcessingConfig,
  SummaryModel,
  WhisperModel,
} from "../api/types";
import {
  deviceSummary,
  PRESET_META,
  PRESET_META_REVISION,
  PRESET_ORDER,
  SUMMARY_MODEL_OPTIONS,
  WHISPER_MODEL_OPTIONS,
} from "../lib/presets";

/**
 * ProcessingSettingsForm — 전역 처리 설정 편집. 프리셋 라디오(권장 배지) +
 * 고급 펼침(whisper 모델/단계별 GPU). 고급 값 수정 시 custom 전환, 이름
 * 프리셋 저장은 이름+언어만 전송(서버가 resolve).
 */

type FormState = {
  preset: PresetName | "custom";
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
  summary_model: SummaryModel;
};

function fromConfig(c: ProcessingConfig): FormState {
  return {
    preset: c.preset,
    language: c.language,
    whisper_model: c.whisper_model,
    devices: { ...c.devices },
    summary_model: c.summary_model,
  };
}

function PresetRadio({
  name,
  checked,
  recommended,
  disabled,
  onSelect,
}: {
  name: PresetName;
  checked: boolean;
  recommended: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const meta = PRESET_META[name];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      title={
        disabled
          ? "모든 프리셋은 GPU를 사용해요 — 이 머신에서는 선택할 수 없어요"
          : undefined
      }
      onClick={onSelect}
      className={cn(
        "flex flex-1 flex-col gap-1 rounded-md border p-3 text-left outline-none transition-colors duration-[80ms] focus-visible:[box-shadow:var(--focus-ring)]",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        checked
          ? "border-[color:var(--accent-6)] bg-[var(--accent-1)]"
          : "border-border hover:bg-[var(--surface-hover)]",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {meta.label}
        {recommended && <Badge variant="accent">권장</Badge>}
      </span>
      <span className="text-xs text-[color:var(--text-muted)]">
        {meta.desc}
      </span>
      <span className="text-xs text-[color:var(--text-secondary)]">
        {meta.whisper_model} · {deviceSummary(meta.devices)}
      </span>
      <span className="text-xs text-[color:var(--text-muted)]">
        요약 {meta.summary_model}
      </span>
    </button>
  );
}

export function ProcessingSettingsForm() {
  const settings = useProcessingSettings();
  const capabilities = useCapabilities();
  const update = useUpdateProcessingSettings();

  const [form, setForm] = React.useState<FormState | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  // 서버 값이 처음 도착하면 폼을 초기화 (렌더 중 조정 패턴 — effect 불필요).
  // 이후 로컬 편집을 보존하고, 저장 성공 시 mutation 응답으로 재동기화한다.
  if (form === null && settings.data) {
    setForm(fromConfig(settings.data));
  }

  if (settings.isLoading || form === null) {
    return (
      <p role="status" className="text-sm text-[color:var(--text-muted)]">
        설정을 불러오는 중…
      </p>
    );
  }
  if (settings.isError) {
    return (
      <p className="text-sm text-[color:var(--red-text)]">
        설정을 불러오지 못했어요.
      </p>
    );
  }

  const caps = capabilities.data;
  // 보수적 기본값(리뷰 #3): 조회 전/실패 시 GPU 불허 — 로딩 중엔 GPU 관련
  // 컨트롤(프리셋 카드 + GPU 스위치)을 잠시 비활성화한다.
  const capsReady = capabilities.isSuccess;
  const gpuEligible = caps?.gpu_eligible === true;
  const presetsDisabled = !capsReady || !gpuEligible; // 모든 프리셋이 diar gpu 포함
  // GPU 스위치 비대칭 규칙(리뷰 #4): 켜기(cpu→gpu)는 비적격 시 차단하되,
  // 이미 gpu인 기존 값을 cpu로 끄는 것은 항상 허용 (옮겨온 DB 등 복구 경로).
  const gpuSwitchDisabled = (current: Device) =>
    !capsReady || (!gpuEligible && current === "cpu");

  const selectPreset = (name: PresetName) => {
    // 현재 서버 preset과 같은 카드를 고르면 서버 resolved 값을 시작값으로
    // 사용(진실원 우선), 다른 카드는 FE 표시 상수 사용 (리뷰 #6 최소 대응).
    const server = settings.data;
    const source =
      server && server.preset === name
        ? {
            whisper_model: server.whisper_model,
            devices: server.devices,
            summary_model: server.summary_model,
          }
        : PRESET_META[name];
    setForm({
      preset: name,
      language: form.language,
      whisper_model: source.whisper_model,
      devices: { ...source.devices },
      summary_model: source.summary_model,
    });
  };

  const setKnob = (patch: Partial<Omit<FormState, "preset">>) => {
    setForm({ ...form, ...patch, preset: "custom" });
  };

  const handleSave = () => {
    const body =
      form.preset === "custom"
        ? {
            preset: "custom" as const,
            language: form.language.trim(),
            whisper_model: form.whisper_model,
            devices: form.devices,
            summary_model: form.summary_model,
          }
        : { preset: form.preset, language: form.language.trim() };
    update.mutate(body, {
      onSuccess: (resolved) => {
        setForm(fromConfig(resolved));
        toast({ variant: "success", title: "처리 설정을 저장했어요." });
      },
      onError: (error) => {
        if (isDemoBlocked(error)) return;
        toast({
          variant: "error",
          title: "저장에 실패했어요.",
          description: isApiError(error) ? error.message : undefined,
        });
      },
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {capsReady && !gpuEligible && (
        <p className="rounded-md border border-[color:var(--border-subtle)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[color:var(--text-secondary)]">
          Damwha가 지원하지 않는 환경이에요 (Apple Silicon Mac 전용). 모든
          프리셋은 GPU를 사용하므로 선택할 수 없고, custom CPU 설정만 편집할 수
          있어요.
        </p>
      )}
      {settings.data &&
        settings.data.preset !== "custom" &&
        settings.data.preset_revision !== null &&
        settings.data.preset_revision !== PRESET_META_REVISION && (
          <p className="text-xs text-[color:var(--text-muted)]">
            서버 프리셋 정의가 업데이트됐어요 — 카드 요약이 실제 값과 다를 수
            있어요. 저장은 항상 서버 기준으로 적용돼요.
          </p>
        )}

      <div role="radiogroup" aria-label="처리 프리셋" className="flex gap-2.5">
        {PRESET_ORDER.map((name) => (
          <PresetRadio
            key={name}
            name={name}
            checked={form.preset === name}
            recommended={caps?.recommended_preset === name}
            disabled={presetsDisabled}
            onSelect={() => selectPreset(name)}
          />
        ))}
      </div>
      {form.preset === "custom" && (
        <p className="text-xs text-[color:var(--text-muted)]">
          사용자 지정 설정을 쓰고 있어요. 프리셋을 누르면 해당 값으로
          되돌아가요.
        </p>
      )}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
          className="self-start text-sm font-medium text-[color:var(--accent-text)] outline-none focus-visible:[box-shadow:var(--focus-ring)]"
        >
          고급 설정 {advancedOpen ? "접기" : "펼치기"}
        </button>

        {advancedOpen && (
          <div className="flex flex-col gap-4 rounded-md border border-[color:var(--border-subtle)] p-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-[color:var(--text-secondary)]">
                전사(Whisper) 모델
              </span>
              <Select
                value={form.whisper_model}
                onValueChange={(v) =>
                  setKnob({ whisper_model: v as WhisperModel })
                }
              >
                <SelectTrigger aria-label="전사 모델">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WHISPER_MODEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-[color:var(--text-secondary)]">
                요약(LLM) 모델
              </span>
              <Select
                value={form.summary_model}
                onValueChange={(v) =>
                  setKnob({ summary_model: v as SummaryModel })
                }
              >
                <SelectTrigger aria-label="요약 모델">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUMMARY_MODEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Switch
              label="화자 분리 GPU 사용"
              checked={form.devices.diarization === "gpu"}
              disabled={gpuSwitchDisabled(form.devices.diarization)}
              title={
                gpuEligible ? undefined : "이 머신에서는 GPU를 켤 수 없어요"
              }
              onChange={(e) =>
                setKnob({
                  devices: {
                    ...form.devices,
                    diarization: e.target.checked ? "gpu" : "cpu",
                  },
                })
              }
            />
            <Switch
              label="전사 GPU 사용"
              checked={form.devices.stt === "gpu"}
              disabled={gpuSwitchDisabled(form.devices.stt)}
              title={
                gpuEligible ? undefined : "이 머신에서는 GPU를 켤 수 없어요"
              }
              onChange={(e) =>
                setKnob({
                  devices: {
                    ...form.devices,
                    stt: e.target.checked ? "gpu" : "cpu",
                  },
                })
              }
            />

            <Input
              label="전사 언어"
              value={form.language}
              onChange={(e) => setKnob({ language: e.target.value })}
            />
          </div>
        )}
      </div>

      <p className="text-xs text-[color:var(--text-faint)]">
        새 모델을 처음 선택하면 첫 처리에서 모델 다운로드로 시간이 오래 걸릴 수
        있어요.
      </p>

      <div>
        <Button
          onClick={handleSave}
          loading={update.isPending}
          disabled={update.isPending || !form.language.trim()}
        >
          저장
        </Button>
      </div>
    </div>
  );
}
