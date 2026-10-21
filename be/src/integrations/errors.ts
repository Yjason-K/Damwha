/** 연동 설치가 남의 파일·링크를 덮어쓰게 될 때. 컨트롤러가 409로 옮긴다. */
export class ConflictError extends Error {
  constructor(readonly target: string) {
    super(`${target} is occupied by something that is not Damwha's`);
    this.name = 'ConflictError';
  }
}

/** 클라이언트 CLI 명령이 실패했을 때. 교체 도중이면 지워진 이전 등록(previous)을 실어 사용자가 되돌릴 수 있게 한다. */
export class IntegrationCommandError extends Error {
  constructor(message: string, readonly previous?: string) {
    super(message);
    this.name = 'IntegrationCommandError';
  }
}
