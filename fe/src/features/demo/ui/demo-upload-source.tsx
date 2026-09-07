import { Icon } from "@/features/meeting/ui/icons";

/**
 * 데모 빌드의 업로드 모달에서 파일 선택 행을 대체한다(투어 설계 §2.4). 파일을 받지 않는
 * 이유는 배포 설계 §3.3의 원문 그대로 — 심사자가 아무 파일이나 넣었는데 같은 결과가 나오면
 * 나머지도 가짜로 의심한다. 받지 않으면 "저장 안 함"이 사실이 된다.
 */
export function DemoUploadSource({ fileLabel }: { fileLabel: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-[color:var(--text-secondary)]">
        오디오 파일
      </span>
      <div className="flex items-center gap-2.5 rounded-sm border border-[color:var(--accent-6)] bg-[var(--accent-1)] px-2.5 py-2">
        <Icon
          name="mic"
          size={15}
          className="shrink-0 text-[color:var(--accent-text)]"
        />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {fileLabel}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-[color:var(--text-muted)]">
        데모라 파일을 받지 않아요. 미리 준비한 테스트 오디오로 처리 흐름을
        보여드려요.
      </p>
    </div>
  );
}
