import { useAutosaveNote } from "../api/notes";
import { NoteEditor } from "./note-editor";

/**
 * 인사이트 레일의 메모 탭 — `useAutosaveNote`를 `NoteEditor`에 이어 붙이는
 * 컨테이너. 화면은 전부 `NoteEditor`가 그린다.
 *
 * `key={meetingId}`로 회의가 바뀌면 편집기를 새로 마운트한다. 이전 회의에서
 * 편집 중이었더라도 새 회의는 읽기모드로 시작해야 하기 때문이다. 대기 중인
 * 입력은 이 리마운트와 무관하게 안전하다 — flush는 `useAutosaveNote`가
 * 소유하고, 그 훅은 여기(부모)에 있어 리마운트되지 않는다.
 */
export function NotePane({ meetingId }: { meetingId: string }) {
  const { body, isLoading, isError, refetch, state, change, flush, retry } =
    useAutosaveNote(meetingId);

  return (
    <NoteEditor
      key={meetingId}
      body={body}
      onChange={change}
      isLoading={isLoading}
      isError={isError}
      saveState={state}
      onDone={flush}
      onRetrySave={retry}
      onReload={() => refetch()}
    />
  );
}
