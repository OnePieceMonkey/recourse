import type { Metadata } from "next";
import { OwnerView } from "@/components/owner/OwnerView";

export const metadata: Metadata = { title: "Owner" };

export default function OwnerPage() {
  return <OwnerView />;
}
