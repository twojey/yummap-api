import { config } from "../../../config.ts";
import type { IRestaurantDetector, DetectionResult } from "../../domain/video/video.pipeline.ts";
import { parseDetectionJson } from "./detection-parser.ts";

// Fallback détecteur OpenAI gpt-4.1-nano (~$0.00007/vidéo, 33% moins cher que 4o-mini).
// Utilisé quand Gemini est en quota daily. JSON mode natif → pas besoin de strip markdown.
export class OpenAIDetectorAdapter implements IRestaurantDetector {
  async detect(input: { description: string; transcription: string }): Promise<DetectionResult> {
    const prompt = `
Tu es un assistant qui extrait les restaurants mentionnés dans la description et la transcription d'une vidéo TikTok/Instagram. La vidéo peut parler d'1, 2 ou plusieurs restaurants (compilations, food crawls…).

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
    {"category": "cuisine",       "name": "<ex: italienne, japonaise, française, vegan, libanaise>"},
    {"category": "type",          "name": "<ex: bistrot, gastronomique, brasserie, bar à vin>"},
    {"category": "ambiance",      "name": "<ex: romantique, familial, festif, calme>"},
    {"category": "moment",        "name": "<ex: brunch, dîner, déjeuner, café, apéro>"},
    {"category": "prix",          "name": "<ex: €, €€, €€€>"},
    {"category": "particularité", "name": "<ex: terrasse, rooftop, vue, étoilé>"}
  ]
}

Règles :
- N'invente AUCUN restaurant. Si tu n'es pas certain, ne le mets pas.
- startSeconds : uniquement si tu vois un repère clair dans la transcription, sinon null.
- Tags : ne mets que ceux pour lesquels tu as une vraie info (ne devine pas).

Sinon :
{"status": "incomplete", "missing": ["name"|"address"]}
    `.trim();

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
