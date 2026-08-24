import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-bold">404</h1>
      <Link to="/" className="underline">
        홈으로
      </Link>
    </main>
  );
}
