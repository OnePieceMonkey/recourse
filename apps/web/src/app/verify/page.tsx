import type { Metadata } from "next";
import { Suspense } from "react";
import { VerifyView } from "@/components/verify/VerifyView";

export const metadata: Metadata = { title: "Verify a receipt" };

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="container page-head"><p className="muted">Loading verifier…</p></div>}>
      <VerifyView />
    </Suspense>
  );
}
