import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

/**
 * 진짜 child_process.ChildProcess 대신 쓰는 가짜. stdout·stderr를 별도 EventEmitter로
 * 두어야 launchWithUv가 각각에 다는 리스너를 실제 ChildProcess와 같은 모양으로 태울 수
 * 있다. EventEmitter 자체가 'error' 이벤트를 리스너 없이 emit하면 동기로 다시 던지는
 * 성질을 이용해 "'error' 리스너가 달려 있는가"를 검증한다.
 */
export function fakeChild(): ChildProcess & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 4242,
    kill: () => true,
  });
  return child;
}
