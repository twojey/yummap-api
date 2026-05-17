import { config } from "../../../config.ts";
import type { IRestaurantDetector, DetectionResult } from "../../domain/video/video.pipeline.ts";
import { parseDetectionJson } from "./detection-parser.ts";
import { buildExtractionPrompt } from "./restaurant-extraction.prompt.ts";

// Fallback détecteur OpenAI gpt-4.1-nano (~$0.00007/vidéo, 33% moins cher que 4o-mini).
// Utilisé quand Gemini est en quota daily. JSON mode natif → pas besoin de strip markdown.
export class OpenAIDetectorAdapter implements IRestaurantDetector {
  async detect(input: { description: string; transcription: string }): Promise<DetectionResult> {
    const prompt = buildExtractionPrompt(input);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-nano",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return parseDetectionJson(text);
  }
}
