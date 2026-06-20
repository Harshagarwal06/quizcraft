"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LessonActions({ lessonId }: { lessonId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function proposeTest() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/coach/lessons/${lessonId}/test`, {
        method: "POST",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error ?? "Couldn't prepare the test proposal.");
      }
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't prepare the test proposal."
      );
      setLoading(false);
    }
  }

  return (
    <div className="mt-8">
      {error && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={proposeTest}
          disabled={loading}
          className="btn-primary"
        >
          {loading ? "Preparing proposal…" : "Test me"}
        </button>
        <Link href="/dashboard" className="btn-ghost">
          Back to plan
        </Link>
      </div>
      <p className="mt-3 text-xs text-muted">
        “Test me” proposes a verified review. You will confirm it on the
        dashboard before any questions are generated.
      </p>
    </div>
  );
}
