import { assertEquals } from "@std/assert";

// Réplique #parseQuotaError de GeminiDetectorAdapter pour le tester isolément.
function parseQuotaError(body: string): { isDaily: boolean; retryDelaySec: number | null; quotaId: string | null } {
  try {
    const j = JSON.parse(body) as {
      error?: {
        details?: Array<{
          "@type"?: string;
          retryDelay?: string;
          violations?: Array<{ quotaId?: string }>;
        }>;
      };
    };
    const details = j.error?.details ?? [];
    const retryInfo = details.find((d) => (d["@type"] ?? "").endsWith("RetryInfo"));
    const quotaFailure = details.find((d) => (d["@type"] ?? "").endsWith("QuotaFailure"));
    const quotaId = quotaFailure?.violations?.[0]?.quotaId ?? null;
    const isDaily = (quotaId ?? "").includes("PerDay");
    const m = retryInfo?.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/);
    const retryDelaySec = m ? Math.ceil(parseFloat(m[1])) : null;
    return { isDaily, retryDelaySec, quotaId };
  } catch {
    const isDaily = /free_tier_requests(?!_per_minute)/i.test(body);
    return { isDaily, retryDelaySec: null, quotaId: null };
  }
}

Deno.test("Gemini quota parsing : quota daily détecté via 'PerDay' dans quotaId", () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" },
          ],
        },
        {
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay: "31.5s",
        },
      ],
    },
  });
  const parsed = parseQuotaError(body);
  assertEquals(parsed.isDaily, true);
  assertEquals(parsed.retryDelaySec, 32);
  assertEquals(parsed.quotaId, "GenerateRequestsPerDayPerProjectPerModel-FreeTier");
});

Deno.test("Gemini quota parsing : RPM (PerMinute) n'est pas daily", () => {
  const body = JSON.stringify({
    error: {
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            { quotaId: "GenerateRequestsPerMinutePerProject" },
          ],
        },
      ],
    },
  });
  const parsed = parseQuotaError(body);
  assertEquals(parsed.isDaily, false);
});

Deno.test("Gemini quota parsing : fallback heuristique sur JSON non-parsable", () => {
  const body = "html error free_tier_requests epuisé";
  const parsed = parseQuotaError(body);
  assertEquals(parsed.isDaily, true);
});
