import { Suspense, lazy, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { router } from "@/app/router";
import { createQueryClient } from "@/shared/api/query-client";
import { env } from "@/shared/config/env";
import { Toaster } from "@/shared/ui/toaster";

// 데모 빌드에서만 청크가 로드된다 — 개발/셀프호스팅 번들에는 안 들어간다.
const DemoNoticeDialog = lazy(() =>
  import("@/features/demo/ui/demo-notice-dialog").then((m) => ({
    default: m.DemoNoticeDialog,
  })),
);

export function AppProviders() {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      {env.demoMode ? (
        <Suspense fallback={null}>
          <DemoNoticeDialog />
        </Suspense>
      ) : null}
    </QueryClientProvider>
  );
}
