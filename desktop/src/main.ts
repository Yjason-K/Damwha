import { app, BrowserWindow } from "electron";

function createWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 860,
    title: "담화",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

app.whenReady().then(() => {
  createWindow();
});

// Phase 1은 창을 닫으면 앱이 끝난다. macOS 관례와 다르며 Phase 2가 재정의한다 (스펙 §4.2).
app.on("window-all-closed", () => {
  app.quit();
});
