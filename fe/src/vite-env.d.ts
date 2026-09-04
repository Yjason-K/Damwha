/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DEMO_MODE?: string;
  /** 데모 투어가 "업로드 결과"로 드러낼 시드 회의 id. 비면 투어의 업로드 단계가 빠진다. */
  readonly VITE_DEMO_TOUR_MEETING_ID?: string;
  /** 업로드 모달에 보일 테스트 오디오 라벨("파일명 · 42.0 MB"). */
  readonly VITE_DEMO_TOUR_FILE_LABEL?: string;
  /** 검색 단계에서 팔레트에 넣을 예시 검색어. */
  readonly VITE_DEMO_TOUR_SEARCH_QUERY?: string;
  /** 링크 미리보기(og:image·og:url)에 붙일 공개 URL. index.html에서 %VITE_PUBLIC_URL%로 치환. */
  readonly VITE_PUBLIC_URL?: string;
}
