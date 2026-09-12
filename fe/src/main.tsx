import "@/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers";
import { installDesktopBridge } from "@/features/meeting/lib/desktop-bridge";

// 데스크톱 앱의 종료 handshake용 훅. 웹에서는 아무도 부르지 않는다.
installDesktopBridge();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
