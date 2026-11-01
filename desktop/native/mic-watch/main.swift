// damwha-mic-watch — 지금 마이크(입력)를 쓰고 있는 앱의 번들 ID 집합을 CoreAudio로 지켜보고 바뀔 때 알린다.
// 마이크를 열지 않는다 — 프로세스 객체의 kAudioProcessPropertyIsRunningInput을 읽기만 하므로 TCC 권한이 필요 없다.
//
// 계약 (desktop/src/process/mic-watch.ts가 이 순서에 기댄다):
//   - stdout: 줄 단위 JSON만. 기동 직후 전체 스냅숏 `{"input":["us.zoom.xos",...]}`을 한 줄 쓰고,
//     이후 정렬한 집합이 바뀔 때만 한 줄 쓴다. 번들 ID가 빈 프로세스는 뺀다.
//   - 조회가 실패하면 `{"error":"<단계> <OSStatus>"}`를 쓰고 1로 끝난다. 오류 뒤에 같은 집합으로 돌아오면
//     새 줄이 없으므로, 계속 도는 대신 끝나서 재기동이 전체 스냅숏을 다시 보장하게 한다.
//   - stdin이 닫히거나(부모가 죽었다) SIGTERM·SIGINT를 받으면 0으로 끝난다.
//
// 1초 폴링이다. 속성 리스너는 프로세스 객체가 생기고 사라질 때마다 다시 달아야 해서 얻는 것보다 복잡하다.

import CoreAudio
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func writeLine(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
    let text = String(data: data, encoding: .utf8)
  else { return }
  print(text)
}

func fail(_ stage: String, _ status: OSStatus) -> Never {
  writeLine(["error": "\(stage) \(status)"])
  exit(1)
}

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
}

/// 마이크를 쓰는 앱의 번들 ID, 정렬·중복 제거.
func inputBundles() -> [String] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var listAddr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  var status = AudioObjectGetPropertyDataSize(system, &listAddr, 0, nil, &size)
  if status != noErr { fail("list-size", status) }
  var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  status = AudioObjectGetPropertyData(system, &listAddr, 0, nil, &size, &objects)
  if status != noErr { fail("list", status) }

  var bundles = Set<String>()
  for object in objects {
    var runningAddr = address(kAudioProcessPropertyIsRunningInput)
    var running: UInt32 = 0
    var runningSize = UInt32(MemoryLayout<UInt32>.size)
    status = AudioObjectGetPropertyData(object, &runningAddr, 0, nil, &runningSize, &running)
    // 목록을 읽은 뒤 프로세스가 끝나면 객체가 사라진다 — 오류가 아니라 그냥 없는 것이다.
    if status == kAudioHardwareBadObjectError { continue }
    if status != noErr { fail("running-input", status) }
    if running == 0 { continue }

    var bundleAddr = address(kAudioProcessPropertyBundleID)
    var bundle: Unmanaged<CFString>?
    var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    status = AudioObjectGetPropertyData(object, &bundleAddr, 0, nil, &bundleSize, &bundle)
    if status == kAudioHardwareBadObjectError { continue }
    if status != noErr { fail("bundle-id", status) }
    // 보유된 CFString이 돌아온다 — takeRetainedValue로 소유권을 받아 새지 않게 한다.
    guard let name = bundle?.takeRetainedValue() as String?, !name.isEmpty else { continue }
    bundles.insert(name)
  }
  return bundles.sorted()
}

// 부모가 죽으면 stdin이 닫힌다. 폴링 루프가 잠든 사이에도 끝나도록 별도 스레드에서 EOF를 기다린다.
Thread.detachNewThread {
  while FileHandle.standardInput.availableData.count > 0 {}
  exit(0)
}
signal(SIGTERM) { _ in _exit(0) }
signal(SIGINT) { _ in _exit(0) }

var last: [String]? = nil
while true {
  let now = inputBundles()
  if now != last {
    writeLine(["input": now])
    last = now
  }
  Thread.sleep(forTimeInterval: 1)
}
