import { createBrowserRouter } from "react-router";
import { HomePage } from "@/pages/home";
import { NotFoundPage } from "@/pages/not-found";
import { ShowcasePage } from "@/pages/showcase";

export const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/showcase", element: <ShowcasePage /> },
  { path: "*", element: <NotFoundPage /> },
]);
