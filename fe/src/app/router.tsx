import { createElement, lazy, Suspense, type ComponentType } from "react";
import { createBrowserRouter } from "react-router";
import { HomePage } from "@/pages/home";
import { NotFoundPage } from "@/pages/not-found";

// Heavy routes are code-split into their own chunks, loaded on demand —
// keeps the initial (landing) bundle small. `/` and `*` stay eager (tiny,
// and avoids a loading flash on first paint).
function lazyRoute(loader: () => Promise<{ default: ComponentType }>) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
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

export const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  {
    path: "/app",
    element: lazyRoute(() =>
      import("@/pages/meeting").then((m) => ({ default: m.MeetingPage })),
    ),
  },
  {
    path: "/showcase",
    element: lazyRoute(() =>
      import("@/pages/showcase").then((m) => ({ default: m.ShowcasePage })),
    ),
  },
  {
    path: "/speakers",
    element: lazyRoute(() =>
      import("@/pages/speakers").then((m) => ({ default: m.SpeakersPage })),
    ),
  },
  { path: "*", element: <NotFoundPage /> },
]);
