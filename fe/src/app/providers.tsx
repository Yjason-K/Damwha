import { RouterProvider } from "react-router";
import { router } from "@/app/router";

export function AppProviders() {
  return <RouterProvider router={router} />;
}
