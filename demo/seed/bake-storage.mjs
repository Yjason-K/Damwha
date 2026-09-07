#!/usr/bin/env node
// 데모 API 이미지 빌드 시 manifest대로 STORAGE_ROOT 레이아웃을 만든다 (deploy/api.Dockerfile의
// seed 스테이지). restore.sh의 find-original.py와 같은 일을 node로 한다 — 빌드 이미지에 python이 없다.
//   node bake-storage.mjs <demo dir> <out dir>
import { readFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

const [demoDir, outDir] = process.argv.slice(2);
if (!demoDir || !outDir) throw new Error("usage: bake-storage.mjs <demo dir> <out dir>");
const manifest = JSON.parse(readFileSync(join(demoDir, "seed/manifest.json"), "utf8"));
const audioFiles = readdirSync(join(demoDir, "audio"));
const nfc = (s) => s.normalize("NFC");

for (const m of manifest) {
  const original = audioFiles.find((f) => nfc(f) === nfc(m.original_filename));
  if (!original) throw new Error(`missing demo/audio/${m.original_filename}`);
  for (const [src, key] of [
    [join(demoDir, "audio", original), m.audio_key],
    [join(demoDir, "seed/storage", m.normalized_key), m.normalized_key],
  ]) {
    mkdirSync(join(outDir, dirname(key)), { recursive: true });
    copyFileSync(src, join(outDir, key));
  }
  console.log(`${m.id}: ${m.audio_key}, ${m.normalized_key}`);
}
