import type { Metadata } from "next";
import { PublisherView } from "@/components/publisher/PublisherView";

export const metadata: Metadata = { title: "Publisher dashboard" };

export default function PublisherPage() {
  return <PublisherView />;
}
