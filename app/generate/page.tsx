"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import NavBar from "@/app/components/NavBar";

type Tab = "pdf" | "notes" | "prompt";

export default function GeneratePage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("notes");
  const [notes, setNotes] = useState("");
  const [prompt, setPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [questionCount, setQuestionCount] = useState(8);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadingStage, setLoadingStage] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(
      () => setLoadingStage((stage) => Math.min(stage + 1, 2)),
      4500
    );
    return () => clearInterval(timer);
  }, [loading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoadingStage(0);
    setLoading(true);
    setError("");

    try {
      let res: Response;

      if (tab === "pdf" && file) {
        const form = new FormData();
        form.append("file", file);
        if (userPrompt) form.append("userPrompt", userPrompt);
        form.append("questionCount", String(questionCount));
        res = await fetch("/api/quizzes", { method: "POST", body: form });
      } else {
        const content = tab === "notes" ? notes : prompt;
        res = await fetch("/api/quizzes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceType: tab,
            content,
            userPrompt: userPrompt || undefined,
            questionCount,
          }),
        });
      }

      if (!res.ok) {
        const data = await res.json();
        // Include the server-provided detail (provider/quota/config reason) so
        // failures are self-diagnosing instead of a generic message.
        const detail = data.detail ? ` (${data.provider ?? "llm"}: ${data.detail})` : "";
        setError((data.error ?? "Generation failed.") + detail);
        return;
      }

      const quiz = await res.json();
      router.push(`/quiz/${quiz.id}`);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: "notes",
      label: "Paste notes",
      icon: <path d="M4 6h16M4 12h16M4 18h10" />,
    },
    {
      id: "pdf",
      label: "Upload PDF",
      icon: <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />,
    },
    {
      id: "prompt",
      label: "Prompt",
      icon: <path d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
    },
  ];

  return (
    <>
      <NavBar />
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-jakarta)' }}>Generate a quiz</h1>
          <p className="mt-1 text-muted">
            Drop in your material and let AI craft balanced, explained MCQs.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="glass-card space-y-6 p-6">
          {/* Tab selector */}
          <div
            className="grid grid-cols-3 gap-1 rounded-xl p-1"
            style={{ backgroundColor: "var(--surface-sunk)" }}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className="flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-all"
                style={
                  tab === t.id
                    ? { backgroundColor: "var(--surface)", color: "var(--primary)", boxShadow: "var(--shadow-sm)" }
                    : { color: "var(--muted)" }
                }
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {t.icon}
                </svg>
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </div>

          {tab === "notes" && (
            <div>
              <label className="label">Your notes</label>
              <textarea
                required
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={10}
                placeholder="Paste study notes, textbook excerpts, or any text…"
                className="field resize-none"
              />
            </div>
          )}

          {tab === "pdf" && (
            <div>
              <label className="label">PDF file</label>
              <div
                onClick={() => fileRef.current?.click()}
                className="cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors"
                style={{ borderColor: file ? "var(--primary)" : "rgba(148, 163, 184, 0.2)" }}
              >
                <svg className="mx-auto mb-2" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
                </svg>
                {file ? (
                  <p className="text-sm font-medium text-foreground">{file.name}</p>
                ) : (
                  <p className="text-sm text-muted">Click to choose a PDF</p>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
          )}

          {tab === "prompt" && (
            <div>
              <label className="label">Topic or description</label>
              <textarea
                required
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="Describe what the quiz should cover…"
                className="field resize-none"
              />
            </div>
          )}

          <div>
            <label className="label">
              Focus hint <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              type="text"
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              placeholder="e.g. emphasize key formulas or chapter 3"
              className="field"
            />
          </div>

          <div>
            <label className="label">
              Questions:{" "}
              <span className="font-semibold" style={{ color: "var(--primary)" }}>{questionCount}</span>
            </label>
            {/* Gradient-filled track behind a transparent native range */}
            <div className="relative flex h-5 items-center">
              <div
                className="absolute h-1.5 w-full rounded-full"
                style={{ backgroundColor: "var(--border)" }}
              />
              <div
                className="absolute h-1.5 rounded-full"
                style={{
                  width: `${((questionCount - 3) / (15 - 3)) * 100}%`,
                  backgroundImage: "var(--brand-gradient-h)",
                }}
              />
              <input
                type="range"
                min={3}
                max={15}
                value={questionCount}
                onChange={(e) => setQuestionCount(Number(e.target.value))}
                className="relative m-0 h-5 w-full cursor-pointer appearance-none bg-transparent"
                style={{ accentColor: "var(--primary)" }}
              />
            </div>
            <div className="mt-0.5 flex justify-between text-xs text-muted">
              <span>3</span>
              <span>15</span>
            </div>
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || (tab === "pdf" && !file)}
            className="btn-primary w-full py-3"
          >
            {loading ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                {[
                  "Preparing your source…",
                  "Planning coverage…",
                  "Creating the first verified questions…",
                ][loadingStage]}
              </>
            ) : (
              "Generate quiz"
            )}
          </button>
        </form>
      </div>
    </>
  );
}
