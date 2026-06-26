import { createBrowserRouter } from "react-router";
import { HomePage } from "@/pages/home";
import { NotFoundPage } from "@/pages/not-found";
import { ShowcasePage } from "@/pages/showcase";
import { MeetingPage } from "@/pages/meeting";

export const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/app", element: <MeetingPage /> },
  { path: "/showcase", element: <ShowcasePage /> },
  { path: "*", element: <NotFoundPage /> },
]);
