import { Link } from "react-router";

import { Button } from "@/shared/ui/button";

export function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-bold">Damwha</h1>
      <Button asChild>
        <Link to="/app">시작하기</Link>
      </Button>
    </main>
  );
}
