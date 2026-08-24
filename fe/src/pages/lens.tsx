import { Navigate, useNavigate, useParams } from "react-router";

import { LENS_META } from "@/features/lens/model/meta";
import type { LensKind } from "@/features/lens/model/types";
import { LensDashboard } from "@/features/lens/ui/lens-dashboard";

function isLensKind(v: string | undefined): v is LensKind {
  return !!v && v in LENS_META;
}

/** `/lenses/:kind` — 전역 렌즈 대시보드. 알 수 없는 kind는 action으로 정규화. */
export function LensView() {
  const { kind } = useParams();
  const navigate = useNavigate();

  if (!isLensKind(kind)) return <Navigate to="/lenses/action" replace />;

  return (
    <LensDashboard
      lens={kind}
      onLens={(k) => navigate(`/lenses/${k}`)}
      onJumpEvidence={(meetingId, utteranceId) =>
        navigate(`/meetings/${meetingId}?u=${utteranceId}`)
      }
    />
  );
}
