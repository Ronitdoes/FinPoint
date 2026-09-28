import type { Metadata } from "next";
import { NotFoundView } from "../components/not-found/NotFoundView";

export const metadata: Metadata = {
  title: "404 - Route Not Found | FinPoint",
  description: "The requested route does not exist in the FinPoint Revenue Recovery platform.",
};

export default function NotFound() {
  return <NotFoundView />;
}
