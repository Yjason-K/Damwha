import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import {
  DEVICES,
  PRESET_NAMES,
  STT_LANGUAGES,
  WHISPER_MODELS,
  type Device,
  type PresetName,
  type SttLanguage,
  type WhisperModel,
} from '@damwha/contracts';
import type { Folder } from './api-types';
import { UsageError } from './errors';

/**
 * CLI `upload`와 MCP `upload_audio`가 같이 쓰는 업로드 옵션 (spec §2.4).
 * 열거형은 contracts에서만 가져온다 — be 업로드 파서(`ProcessingOverrideSchema`,
 * `SpeakerBoundsSchema`)와 어긋나면 API가 이유 없이 `Invalid input`만 답하기 때문이다.
 */
export interface UploadOptions {
  title?: string;
  recordedAt?: string;
  folder?: string;
  preset?: PresetName;
  whisperModel?: WhisperModel;
  sttDevice?: Device;
  diarizationDevice?: Device;
  language?: SttLanguage;
  speakers?: { min?: number; max?: number };
  noSummary?: boolean;
  noLens?: boolean;
}

/** CLI는 kebab-case(`stt-device`), MCP 입력은 camelCase를 줄 수 있다. 둘 다 받는다. */
function pick(raw: Record<string, unknown>, kebab: string): unknown {
  const camel = kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return raw[kebab] ?? raw[camel];
}

function pickString(raw: Record<string, unknown>, kebab: string): string | undefined {
  const v = pick(raw, kebab);
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function pickEnum<T extends string>(
  raw: Record<string, unknown>,
  kebab: string,
  allowed: readonly T[],
): T | undefined {
  const v = pickString(raw, kebab);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new UsageError(`--${kebab}: invalid value '${v}'`, kebab, allowed);
  }
  return v as T;
}

function pickCount(raw: Record<string, unknown>, kebab: string): number | undefined {
  const v = pick(raw, kebab);
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || n < 1 || n > 20) {
    throw new UsageError(`--${kebab}: must be an integer from 1 to 20 (got '${s}')`, kebab);
  }
  return n;
}

function pickFlag(raw: Record<string, unknown>, kebab: string): boolean | undefined {
  const v = pick(raw, kebab);
  if (v === undefined || v === null) return undefined;
  return v === true || v === 'true';
}

export function parseUploadOptions(raw: Record<string, unknown>): UploadOptions {
  const opts: UploadOptions = {};

  const title = pickString(raw, 'title');
  if (title !== undefined) opts.title = title;

  const recordedAt = pickString(raw, 'recorded-at');
  if (recordedAt !== undefined) {
    const t = Date.parse(recordedAt);
    if (Number.isNaN(t)) {
      throw new UsageError(`--recorded-at: not an ISO 8601 date-time ('${recordedAt}')`, 'recorded-at');
    }
    opts.recordedAt = new Date(t).toISOString();
  }

  const folder = pickString(raw, 'folder');
  if (folder !== undefined) opts.folder = folder;

  const preset = pickEnum(raw, 'preset', PRESET_NAMES);
  if (preset) opts.preset = preset;
  const whisperModel = pickEnum(raw, 'whisper-model', WHISPER_MODELS);
  if (whisperModel) opts.whisperModel = whisperModel;
  const sttDevice = pickEnum(raw, 'stt-device', DEVICES);
  if (sttDevice) opts.sttDevice = sttDevice;
  const diarizationDevice = pickEnum(raw, 'diarization-device', DEVICES);
  if (diarizationDevice) opts.diarizationDevice = diarizationDevice;
  const language = pickEnum(raw, 'language', STT_LANGUAGES);
  if (language) opts.language = language;

  const both = pickCount(raw, 'speakers');
  const min = pickCount(raw, 'min-speakers');
  const max = pickCount(raw, 'max-speakers');
  if (both !== undefined && (min !== undefined || max !== undefined)) {
    throw new UsageError('--speakers cannot be combined with --min-speakers/--max-speakers', 'speakers');
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new UsageError(`--min-speakers (${min}) must be <= --max-speakers (${max})`, 'min-speakers');
  }
  if (both !== undefined) opts.speakers = { min: both, max: both };
  else if (min !== undefined || max !== undefined) {
    opts.speakers = {
      ...(min !== undefined && { min }),
      ...(max !== undefined && { max }),
    };
  }

  if (pickFlag(raw, 'no-summary')) opts.noSummary = true;
  if (pickFlag(raw, 'no-lens')) opts.noLens = true;
  return opts;
}

/**
 * 파일을 뺀 텍스트 필드들. be 계약 테스트가 이 JSON을 be의 zod 스키마로 직접 검증한다.
 * 준 것만 싣는다 — `processing`이 비면 필드 자체를 빼야 앱 설정값이 그대로 쓰인다.
 */
export function buildUploadFields(
  opts: UploadOptions,
  folderId: string | undefined,
  fileMtime: Date,
): Record<string, string> {
  const fields: Record<string, string> = {
    recorded_at: opts.recordedAt ?? fileMtime.toISOString(),
  };
  if (opts.title !== undefined) fields.title = opts.title;
  if (folderId !== undefined) fields.folder_id = folderId;

  const processing: Record<string, unknown> = {};
  if (opts.preset) processing.preset = opts.preset;
  if (opts.whisperModel) processing.whisper_model = opts.whisperModel;
  if (opts.language) processing.language = opts.language;
  const devices: Record<string, Device> = {};
  if (opts.sttDevice) devices.stt = opts.sttDevice;
  if (opts.diarizationDevice) devices.diarization = opts.diarizationDevice;
  if (Object.keys(devices).length) processing.devices = devices;
  if (Object.keys(processing).length) fields.processing = JSON.stringify(processing);

  if (opts.speakers) fields.speakers = JSON.stringify(opts.speakers);
  if (opts.noSummary) fields.defer_summary = 'true';
  if (opts.noLens) fields.defer_lens = 'true';
  return fields;
}

export async function buildUploadForm(
  filePath: string,
  opts: UploadOptions,
  folderId: string | undefined,
  fileMtime: Date,
): Promise<FormData> {
  const form = new FormData();
  for (const [k, v] of Object.entries(buildUploadFields(opts, folderId, fileMtime))) form.set(k, v);
  // openAsBlob은 파일을 메모리에 올리지 않고 읽는 시점에 스트리밍한다. 이름은 원래 파일 이름 그대로.
  form.set('audio', await openAsBlob(filePath), basename(filePath));
  return form;
}

const FOLDER_ID = /^fld_[1-9][0-9]*$/;

export async function resolveFolderId(
  client: { listFolders(): Promise<Folder[]> },
  folder: string,
): Promise<string> {
  if (FOLDER_ID.test(folder)) return folder;
  const hits = (await client.listFolders()).filter((f) => f.name === folder);
  if (hits.length === 0) throw new UsageError(`--folder: no folder named '${folder}'`, 'folder');
  if (hits.length > 1) {
    throw new UsageError(
      `--folder: ${hits.length} folders are named '${folder}'; use an id instead (${hits.map((f) => f.id).join(', ')})`,
      'folder',
    );
  }
  return hits[0].id;
}
