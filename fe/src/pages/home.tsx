import { Button } from "@/shared/ui/button";

export function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-bold">Damwha</h1>
      <Button>시작하기</Button>
    </main>
  );
}
