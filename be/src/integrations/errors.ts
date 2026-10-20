/** 연동 설치가 남의 파일·링크를 덮어쓰게 될 때. 컨트롤러가 409로 옮긴다. */
export class ConflictError extends Error {
  constructor(readonly target: string) {
    super(`${target} is occupied by something that is not Damwha's`);
    this.name = 'ConflictError';
  }
}
