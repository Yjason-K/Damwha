import { Suspense, lazy, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { router } from "@/app/router";
import { installDemoTour } from "@/features/demo/api/demo-tour-interceptor";
import { readTourState } from "@/features/demo/model/tour-state";
import { simulationView } from "@/features/demo/model/upload-simulation";
import { apiClient } from "@/shared/api/client";
import { createQueryClient } from "@/shared/api/query-client";
import { env } from "@/shared/config/env";
import { Toaster } from "@/shared/ui/toaster";

// 데모 빌드에서만 청크가 로드된다 — 개발/셀프호스팅 번들에는 안 들어간다.
const DemoNoticeDialog = lazy(() =>
  import("@/features/demo/ui/demo-notice-dialog").then((m) => ({
    default: m.DemoNoticeDialog,
  })),
);

// 데모 투어의 응답 가공(투어 설계 §2.7). 회의 id가 없으면 투어는 업로드 단계 없이 돈다.
if (env.demoTour) {
  installDemoTour(apiClient, {
    tourMeetingId: env.demoTour.meetingId,
    isUploaded: () => readTourState().uploaded,
    view: simulationView,
  });
}

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
