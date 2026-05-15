import { config } from "../../../config.ts";
import type { IRestaurantDetector, DetectionResult } from "../../domain/video/video.pipeline.ts";
import { DailyQuotaExceededError } from "../../shared/errors.ts";
import { parseDetectionJson } from "./detection-parser.ts";

// Détecteur Groq (llama-3.3-70b-versatile). Free tier 1000 req/jour, API
// compatible OpenAI. Utilisé comme 2e fallback après Gemini, avant OpenAI payant.
export class GroqDetectorAdapter implements IRestaurantDetector {
  async detect(input: { description: string; transcription: string }): Promise<DetectionResult> {
    const prompt = `
Tu es un assistant qui extrait les restaurants mentionnés dans la description et la transcription d'une vidéo TikTok/Instagram. La vidéo peut parler d'1, 2 ou plusieurs restaurants (cas typique : compilations "top 5", food crawls "on a fait 3 spots").

Description de la vidéo : """${input.description}"""
Transcription audio : """${input.transcription}"""

Réponds en JSON. Deux formats possibles :

Si tu identifies au moins 1 restaurant avec son nom ET son adresse/arrondissement :
{
  "status": "complete",
  "restaurants": [
    { "name": "<nom>", "address": "<adresse>", "startSeconds": <int|null> }
    // ... un objet par restaurant dans l'ordre où ils apparaissent dans la vidéo
  ],
  "tags": [
    {"category": "cuisine", "name": "<ex: italienne, japonaise, française, vegan>"},
    {"category": "type", "name": "<ex: bistrot, gastronomique, bar à vin>"},
    {"category": "ambiance", "name": "<ex: romantique, familial, festif>"},
    {"category": "moment", "name": "<ex: brunch, dîner, apéro>"},
    {"category": "prix", "name": "<ex: €, €€, €€€>"},
    {"category": "particularité", "name": "<ex: terrasse, rooftop, étoilé>"}
  ]
}

Règles importantes :
- N'invente AUCUN restaurant. Si tu n'es pas certain qu'un endroit est mentionné, ne le mets pas.
- Mets startSeconds uniquement si tu vois clairement un timestamp dans la transcription, sinon null.
- Les tags sont partagés (la vidéo a une ambiance globale, pas un set de tags par resto).
- Ne mets que les tags pour lesquels tu as une vraie info (ne devine pas).

Sinon : {"status": "incomplete", "missing": ["name"|"address"]}
    `.trim();

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
