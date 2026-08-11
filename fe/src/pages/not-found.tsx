export function NotFoundPage() {
  return (
    <main className="col-start-2 flex h-full flex-col items-center justify-center gap-2 bg-background text-foreground">
      <h1 className="text-3xl font-bold">404</h1>
      <p className="text-sm text-[color:var(--text-muted)]">
        찾을 수 없는 페이지예요. 왼쪽에서 회의를 골라 주세요.
      </p>
    </main>
  );
}
