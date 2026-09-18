import type { Metadata } from "next";
import { Suspense } from "react";
import { ActivityLookup } from "@/components/app/ActivityLookup";

export const metadata: Metadata = { title: "Activity — CeloTasker" };

export default function ActivityPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">Loading activity…</p>}>
      <ActivityLookup />
    </Suspense>
  );
}