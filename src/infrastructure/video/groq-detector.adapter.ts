import { config } from "../../../config.ts";
import type { IRestaurantDetector, DetectionResult } from "../../domain/video/video.pipeline.ts";
import { DailyQuotaExceededError } from "../../shared/errors.ts";
import { parseDetectionJson } from "./detection-parser.ts";
import { buildExtractionPrompt } from "./restaurant-extraction.prompt.ts";

// Détecteur Groq (llama-3.3-70b-versatile). Free tier 1000 req/jour, API
// compatible OpenAI. Utilisé comme 2e fallback après Gemini, avant OpenAI payant.
export class GroqDetectorAdapter implements IRestaurantDetector {
  async detect(input: { description: string; transcription: string }): Promise<DetectionResult> {
    const prompt = buildExtractionPrompt(input);

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.groq.apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      // 429 daily quota Groq → laisse passer au fallback suivant (OpenAI)
      if (response.status === 429) {
        const resumeAfter = new Date(Date.now() + 60 * 60 * 1000); // retry dans 1h
        throw new DailyQuotaExceededError("groq", resumeAfter, body.slice(0, 300));
      }
      throw new Error(`Groq API error: ${response.status} ${body.slice(0, 300)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return parseDetectionJson(text);
  }
}
