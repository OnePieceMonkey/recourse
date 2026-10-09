import type { Metadata } from "next";
import { LogView } from "@/components/log/LogView";

export const metadata: Metadata = { title: "Transparency log" };

export default function LogPage() {
  return <LogView />;
}
