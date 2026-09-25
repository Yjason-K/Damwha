/**
 * 화자 분리 모델을 받지 못해 실패한 회의의 안내 (스펙 2026-09-25 §3.5). 코드는 worker의 errors.py —
 * HF_TOKEN_INVALID(401)·HF_GATE_NOT_ACCEPTED(403) — 와 같은 문자열이다.
 */
export interface HfFailureCopy {
  title: string;
  body: string;
  action: "token" | "accept";
}

export function hfFailureCopy(code: string | undefined): HfFailureCopy | null {
  if (code === "hf_token_invalid") {
    return {
      title: "회의를 처리하지 못했어요",
      body: "허깅페이스 토큰이 없거나 맞지 않아요. 토큰을 넣은 뒤 재처리해 주세요.",
      action: "token",
    };
  }
  if (code === "hf_gate_not_accepted") {
    return {
      title: "회의를 처리하지 못했어요",
      body: "이 토큰의 계정이 모델 사용 조건에 동의하지 않았어요. 동의한 뒤 재처리해 주세요.",
      action: "accept",
    };
  }
  return null;
}
