// damwha-system-audio — 이 맥에서 나는 소리(시스템 오디오)를 CoreAudio Process Tap으로 받아
// 16 kHz · mono · int16 LE PCM으로 stdout에 흘린다. 라이브 녹음의 마이크와 같은 형식이라
// 렌더러는 샘플 단위로 더하기만 하면 된다.
//
// 계약 (desktop/src/process/system-audio.ts가 이 순서에 기댄다):
//   - stdout: PCM 바이트만. 다른 것은 절대 쓰지 않는다.
//   - stderr: 한 줄짜리 상태. 준비가 끝나면 정확히 "READY"를 한 번, 실패하면 "ERROR <단계> <OSStatus>".
//   - stdin이 닫히거나(부모가 죽었다) SIGTERM·SIGINT를 받으면 IOProc을 멈추고 aggregate와 tap을
//     지운 뒤 0으로 끝난다. aggregate·tap은 private이라 이 프로세스가 비정상 종료해도 OS가 거둔다.
//
// 권한: tap은 "시스템 오디오 녹음" TCC 권한 아래 있다. 거부되면 tap 생성은 성공한 채 0만 흘러온다 —
// 오류로 드러나지 않으므로 이 헬퍼가 판정하지 않는다. Info.plist의 NSAudioCaptureUsageDescription이
// 없으면 프롬프트조차 뜨지 않는다.
//
// 담화 자신이 내는 소리는 tap에서 뺀다 — 회의 화면에서 녹음 샘플을 재생하면 그 소리가 다시 녹음에 섞이기
// 때문이다. Chromium은 소리를 main이 아니라 오디오 서비스 utility 프로세스(`--utility-sub-type=audio.mojom.AudioService`)
// 에서 내므로, 부모(Electron main)만이 아니라 부모의 자식 전부를 뺀다. 제외 목록은 tap을 만들 때 한 번 정한다 —
// 실측(2026-10-26, macOS 27.2): 돌고 있는 tap에 kAudioTapPropertyDescription을 다시 쓰면 '!hog'로 거부된다.
// 녹음기가 마이크·AudioContext를 연 **뒤에** 헬퍼를 띄우므로 그때 오디오 서비스는 이미 CoreAudio 프로세스다.

import AVFoundation
import CoreAudio
import Foundation

let targetRate: Double = 16_000

func fail(_ stage: String, _ status: OSStatus) -> Never {
  FileHandle.standardError.write("ERROR \(stage) \(status)\n".data(using: .utf8)!)
  exit(1)
}

func check(_ status: OSStatus, _ stage: String) {
  if status != noErr { fail(stage, status) }
}

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
}

func parentPID(of pid: pid_t) -> pid_t? {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
  return info.kp_eproc.e_ppid
}

/// 담화(부모)와 그 자식 프로세스의 CoreAudio 객체. 소리를 낸 적이 없는 프로세스는 객체가 없다 — 뺄 것도 없다.
func damwhaProcessObjects(damwha: pid_t) -> [AudioObjectID] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
  var list = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &list) == noErr else { return [] }
  return list.filter { object in
    var pidAddr = address(kAudioProcessPropertyPID)
    var pid: pid_t = -1
    var pidSize = UInt32(MemoryLayout<pid_t>.size)
    guard AudioObjectGetPropertyData(object, &pidAddr, 0, nil, &pidSize, &pid) == noErr else { return false }
    return pid == damwha || parentPID(of: pid) == damwha
  }
}

func defaultOutputUID() -> String {
  var addr = address(kAudioHardwarePropertyDefaultSystemOutputDevice)
  var device = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  check(
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device),
    "default-output")
  var uidAddr = address(kAudioDevicePropertyDeviceUID)
  var uid: Unmanaged<CFString>?
  size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  check(AudioObjectGetPropertyData(device, &uidAddr, 0, nil, &size, &uid), "output-uid")
  guard let value = uid?.takeRetainedValue() else { fail("output-uid", -1) }
  return value as String
}

// ── tap과 aggregate ─────────────────────────────────────────────────────────

let damwhaPID = getppid()
let excluded = damwhaProcessObjects(damwha: damwhaPID)
let tapDescription = CATapDescription(monoGlobalTapButExcludeProcesses: excluded)
tapDescription.uuid = UUID()
tapDescription.isPrivate = true
tapDescription.muteBehavior = .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateProcessTap(tapDescription, &tapID), "create-tap")

let outputUID = defaultOutputUID()
let aggregateDescription: [String: Any] = [
  kAudioAggregateDeviceNameKey: "Damwha System Audio",
  kAudioAggregateDeviceUIDKey: "kr.damwha.system-audio.\(UUID().uuidString)",
  kAudioAggregateDeviceMainSubDeviceKey: outputUID,
  kAudioAggregateDeviceIsPrivateKey: true,
  kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
  kAudioAggregateDeviceTapListKey: [
    [
      kAudioSubTapDriftCompensationKey: true,
      kAudioSubTapUIDKey: tapDescription.uuid.uuidString,
    ]
  ],
]

var aggregateID = AudioObjectID(kAudioObjectUnknown)
let createStatus = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
if createStatus != noErr {
  AudioHardwareDestroyProcessTap(tapID)
  fail("create-aggregate", createStatus)
}

var formatAddr = address(kAudioTapPropertyFormat)
var tapFormat = AudioStreamBasicDescription()
var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
check(AudioObjectGetPropertyData(tapID, &formatAddr, 0, nil, &formatSize, &tapFormat), "tap-format")

guard
  let inputFormat = AVAudioFormat(streamDescription: &tapFormat),
  let outputFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: targetRate, channels: 1, interleaved: true),
  let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
else { fail("converter", -1) }

// ── IOProc ──────────────────────────────────────────────────────────────────

let stdout = FileHandle.standardOutput
let ioQueue = DispatchQueue(label: "kr.damwha.system-audio.io")
var procID: AudioDeviceIOProcID?

let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) {
  _, inputData, _, _, _ in
  guard
    let input = AVAudioPCMBuffer(
      pcmFormat: inputFormat, bufferListNoCopy: inputData, deallocator: nil),
    input.frameLength > 0
  else { return }
  let capacity = AVAudioFrameCount(
    (Double(input.frameLength) * targetRate / inputFormat.sampleRate).rounded(.up) + 16)
  guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
  var consumed = false
  var error: NSError?
  converter.convert(to: output, error: &error) { _, status in
    if consumed {
      status.pointee = .noDataNow
      return nil
    }
    consumed = true
    status.pointee = .haveData
    return input
  }
  if error != nil || output.frameLength == 0 { return }
  let bytes = Int(output.frameLength) * MemoryLayout<Int16>.size
  stdout.write(Data(bytes: output.int16ChannelData![0], count: bytes))
}
check(ioStatus, "create-ioproc")
check(AudioDeviceStart(aggregateID, procID), "start")

// ── 정리 ────────────────────────────────────────────────────────────────────

let cleanupLock = NSLock()
var cleanedUp = false

func cleanupAndExit() -> Never {
  cleanupLock.lock()
  if !cleanedUp {
    cleanedUp = true
    AudioDeviceStop(aggregateID, procID)
    if let procID { AudioDeviceDestroyIOProcID(aggregateID, procID) }
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
  }
  exit(0)
}

// 부모가 파이프를 닫으면 stdout 쓰기가 SIGPIPE로 프로세스를 죽인다 — 정리 없이 죽지 않도록 무시하고,
// 끝은 stdin EOF와 신호가 맡는다.
signal(SIGPIPE, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { cleanupAndExit() }
  source.resume()
  signalSources.append(source)
}

FileHandle.standardInput.readabilityHandler = { handle in
  if handle.availableData.isEmpty {
    DispatchQueue.main.async { cleanupAndExit() }
  }
}

FileHandle.standardError.write("READY\n".data(using: .utf8)!)
dispatchMain()
