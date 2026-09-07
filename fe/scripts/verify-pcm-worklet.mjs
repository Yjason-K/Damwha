#!/usr/bin/env node
/**
 * `pnpm fe build`가 만든 실제 Worklet 산출물을 검증한다. tsc 통과와 vitest는 pcm-worklet.ts를
 * pre-bundle해서 돌기 때문에 여기서 확인하는 실패 — `.ts`를 URL 에셋으로 복사하는 옛 방식으로
 * 되돌아가는 회귀(설계 §8) — 를 잡지 못한다. `dist/assets/pcm-worklet-*.js`를 정확히 하나
 * 찾고, node:vm으로 평가한 뒤 protocol 테스트와 같은 begin/flush 시퀀스를 몰아 실제 산출물이
 * 프로토콜을 지키는지까지 확인한다.
 *
 * Node vm 통과는 브라우저 AudioWorklet 지원 증명이 아니다 — 브라우저 addModule() 스모크는
 * Task 7이 별도로 한다.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(here, "..", "dist", "assets");

const entries = await readdir(assetsDir);
const strayTs = entries.filter((f) => /^pcm-worklet-.*\.ts$/.test(f));
assert.equal(
  strayTs.length,
  0,
  `pcm-worklet.ts를 URL 에셋으로 그대로 복사하는 옛 방식으로 되돌아갔다 (설계 §8): ${strayTs.join(", ")}`,
);
const matches = entries.filter((f) => /^pcm-worklet-.*\.js$/.test(f));
assert.equal(
  matches.length,
  1,
  `dist/assets/pcm-worklet-*.js가 정확히 하나여야 한다 (found ${matches.length}: ${matches.join(", ")})`,
);

const source = await readFile(path.join(assetsDir, matches[0]), "utf8");

let Processor;
const sandbox = {
  registerProcessor(name, ctor) {
    if (name !== "pcm-processor") throw new Error("unexpected processor");
    Processor = ctor;
  },
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { postMessage() {}, onmessage: null };
    }
  },
  Float32Array,
  Int16Array,
  Uint8Array,
  ArrayBuffer,
};
vm.runInNewContext(source, sandbox, { timeout: 1000 });
assert.equal(typeof Processor, "function");

// 여기부터는 pcm-worklet-protocol.test.ts의 "128/256/137 quantum · 2채널 downmix ·
// flush" 시나리오를 그대로 몰아, 실제 산출물이 파싱만 되는 게 아니라 protocol을
// 지키는지 검사한다.
const instance = new Processor();
const sent = [];
instance.port.postMessage = (message) => sent.push(message);

const mono = (n, value) => [new Float32Array(n).fill(value)];
const stereo = (n, a, b) => [
  new Float32Array(n).fill(a),
  new Float32Array(n).fill(b),
];
const feed = (channels) => instance.process([channels]);
const send = (command) => instance.port.onmessage({ data: command });
const pcmOf = (event) => {
  assert.equal(event.type, "pcm");
  return Array.from(new Int16Array(event.pcm));
};

// vm 샌드박스는 sent[i]를 별도 렐름의 Object로 만든다 — deepEqual로 전체 객체를
// 비교하면 구조가 같아도 프로토타입이 달라 실패한다. 원시값(.type)만 비교한다.
// (Int16Array/ArrayBuffer는 sandbox에 우리 렐름 것을 그대로 주입했으니 pcmOf의
// Array.from 결과는 이 문제가 없다.)

// begin 전: 무음(0)도 유효한 입력이라 첫 quantum에서 ready 한 번, PCM은 없다.
feed(mono(128, 0));
feed(mono(128, 0));
assert.equal(sent.length, 1);
assert.equal(sent[0].type, "ready");

send({ type: "begin" });
assert.equal(sent[1].type, "begun");

// 256샘플 2채널(1, -1) downmix = 0, 137샘플 단채널(1) → 393샘플 누적, 아직 512 미만.
feed(stereo(256, 1, -1));
feed(mono(137, 1));
assert.equal(sent.length, 2);

// 128샘플(1)을 더하면 393+128=521 → 완전한 512프레임 하나 + 9샘플 rest.
feed(mono(128, 1));
assert.equal(sent.length, 3);
const frame = pcmOf(sent[2]);
assert.equal(frame.length, 512);
assert.deepEqual(frame.slice(0, 256), Array(256).fill(0));
assert.deepEqual(frame.slice(256), Array(256).fill(32767));

// flush: 남은 9샘플(1)을 패딩 없이 pcm으로 낸 뒤 flushed. 두 번째 flush는 무시된다.
send({ type: "flush" });
assert.equal(sent.length, 5);
assert.deepEqual(pcmOf(sent[3]), Array(9).fill(32767));
assert.equal(sent[4].type, "flushed");
send({ type: "flush" });
assert.equal(sent.length, 5);

console.log(`ok: ${matches[0]} honors the Worklet flush protocol`);
