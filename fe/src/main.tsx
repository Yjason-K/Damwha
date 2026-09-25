import "@/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers";
import { installDesktopBridge } from "@/features/meeting/lib/desktop-bridge";
import { themeStore } from "@/shared/lib/theme";

// 데스크톱 앱의 종료 handshake용 훅. 웹에서는 아무도 부르지 않는다.
installDesktopBridge();

// 인라인 스크립트가 붙인 테마를 이어받고, 시스템·다른 탭 변경을 따르기 시작한다.
// React 밖에서 한 번 — StrictMode의 이중 마운트가 리스너를 두 번 걸지 않게.
themeStore.start();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
