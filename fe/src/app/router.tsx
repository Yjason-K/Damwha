import { createElement, lazy, Suspense, type ComponentType } from "react";
import { createBrowserRouter, type RouteObject } from "react-router";

import { AppShell } from "@/app/app-shell";
import { IndexRoute } from "@/pages/index-route";
import { NotFoundPage } from "@/pages/not-found";

// 셸(AppShell·LeftNav·인덱스)은 모든 화면에서 필요하므로 eager. 나머지 뷰는
// 각자 청크로 분리해 필요할 때 받는다. fallback은 그리드의 col 2에 놓인다.
function lazyRoute(loader: () => Promise<{ default: ComponentType }>) {
  return (
    <Suspense
      fallback={
        <div className="col-start-2 flex h-full items-center justify-center bg-background">
          <span
            role="status"
            aria-label="로딩 중"
            className="size-5 animate-spin rounded-full border-2 border-[color:var(--text-muted)] border-r-transparent"
          />
        </div>
      }
    >
      {createElement(lazy(loader))}
    </Suspense>
  );
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <IndexRoute /> },
      {
        path: "meetings/:meetingId",
        element: lazyRoute(() =>
          import("@/pages/meeting").then((m) => ({ default: m.MeetingRoute })),
        ),
      },
      {
        path: "lenses/:kind",
        element: lazyRoute(() =>
          import("@/pages/lens").then((m) => ({ default: m.LensView })),
        ),
      },
      {
        path: "speakers",
        element: lazyRoute(() =>
          import("@/pages/speakers").then((m) => ({ default: m.SpeakersPage })),
        ),
      },
      {
        path: "settings",
        element: lazyRoute(() =>
          import("@/pages/settings").then((m) => ({ default: m.SettingsPage })),
        ),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
  {
    path: "/showcase",
    element: lazyRoute(() =>
      import("@/pages/showcase").then((m) => ({ default: m.ShowcasePage })),
    ),
  },
];

export const router = createBrowserRouter(routes);
