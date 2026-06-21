import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchGeminiWithFallback,
  getGeminiApiKeys,
  resetGeminiKeyPoolForTests,
} from "../lib/llm/gemini-keys";

test("Gemini key pool supports three unique keys with legacy compatibility", () => {
  assert.deepEqual(
    getGeminiApiKeys({
      GEMINI_API_KEYS: "pool-a,pool-b",
      GEMINI_API_KEY_1: "pool-a",
      GEMINI_API_KEY_2: "slot-b",
      GEMINI_API_KEY_3: "slot-c",
      GEMINI_API_KEY: "legacy",
    } as NodeJS.ProcessEnv),
    ["pool-a", "pool-b", "slot-b"]
  );
});

test("Gemini key pool fails over from a quota-exhausted key", async () => {
  resetGeminiKeyPoolForTests();
  const attempts: string[] = [];
  const mockFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = url.searchParams.get("key") ?? "";
    attempts.push(key);
    if (key === "exhausted") {
      return new Response(
        JSON.stringify({ error: { message: "Quota exceeded." } }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const response = await fetchGeminiWithFallback({
    endpoint:
      "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
    init: { method: "POST" },
    timeoutMs: 1000,
    label: "Test Gemini call",
    fetchImpl: mockFetch,
    keys: ["exhausted", "healthy", "unused"],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(attempts, ["exhausted", "healthy"]);
});

test("Gemini key pool fails over after a network error", async () => {
  resetGeminiKeyPoolForTests();
  const attempts: string[] = [];
  const mockFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = url.searchParams.get("key") ?? "";
    attempts.push(key);
    if (key === "offline") throw new TypeError("fetch failed");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  await fetchGeminiWithFallback({
    endpoint:
      "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
    init: { method: "POST" },
    timeoutMs: 1000,
    label: "Test Gemini call",
    fetchImpl: mockFetch,
    keys: ["offline", "healthy"],
  });

  assert.deepEqual(attempts, ["offline", "healthy"]);
});

test("Gemini key pool does not hide a non-retryable request error", async () => {
  resetGeminiKeyPoolForTests();
  const attempts: string[] = [];
  const mockFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    attempts.push(url.searchParams.get("key") ?? "");
    return new Response(
      JSON.stringify({ error: { message: "Invalid request body." } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  await assert.rejects(
    fetchGeminiWithFallback({
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
      init: { method: "POST" },
      timeoutMs: 1000,
      label: "Test Gemini call",
      fetchImpl: mockFetch,
      keys: ["first", "second"],
    }),
    /Invalid request body/
  );
  assert.deepEqual(attempts, ["first"]);
});
