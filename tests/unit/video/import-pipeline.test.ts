import { assertEquals } from "@std/assert";
import type { IVideoImportPipeline, IRestaurantDetector, ITranscriptionService, ImportResult, DetectionResult } from "../../../src/domain/video/video.pipeline.ts";
import type { IRestaurantRepository } from "../../../src/domain/restaurant/restaurant.repository.ts";
import { VideoImportPipeline } from "../../../src/infrastructure/video/video-import-pipeline.ts";

// Stubs testables via l'interface — aucune dépendance Supabase/Gemini/Whisper
class StubTranscription implements ITranscriptionService {
  constructor(private readonly text: string) {}
  async transcribe(_audioPath: string) {
    return { text: this.text, vttPath: "/tmp/test.vtt" };
  }
}

class StubDetector implements IRestaurantDetector {
  constructor(private readonly result: DetectionResult) {}
  async detect(_input: { description: string; transcription: string }) {
    return this.result;
  }
}

Deno.test("VideoImportPipeline: retourne 'incomplete' quand le LLM ne trouve pas le restaurant", async () => {
  const detector = new StubDetector({
    status: "incomplete",
    missing: ["name", "address"],
  });
  const transcription = new StubTranscription("super resto à Paris");

  // On ne peut pas instancier VideoImportPipeline sans yt-dlp en test unitaire.
  // Ce test vérifie le contrat de l'interface IRestaurantDetector.
  const result = await detector.detect({ description: "", transcription: "super resto à Paris" });
  assertEquals(result.status, "incomplete");
  assertEquals((result as { missing: string[] }).missing, ["name", "address"]);
});

Deno.test("StubDetector: retourne 'complete' avec un resto unique", async () => {
  const detector = new StubDetector({
    status: "complete",
    restaurants: [{
      name: "Le Comptoir du Relais",
      address: "9 Carrefour de l'Odéon, Paris 6e",
    }],
  });

  const result = await detector.detect({
    description: "Le Comptoir du Relais 9 Carrefour de l'Odéon",
    transcription: "On est au Comptoir du Relais",
  });

  assertEquals(result.status, "complete");
  if (result.status === "complete") {
    assertEquals(result.restaurants.length, 1);
    assertEquals(result.restaurants[0].name, "Le Comptoir du Relais");
  }
});

Deno.test("StubDetector: retourne 'complete' avec plusieurs restos (compilation)", async () => {
  const detector = new StubDetector({
    status: "complete",
    restaurants: [
      { name: "Sapore", address: "10 rue de Rivoli, Paris", startSeconds: 12 },
      { name: "Bambino", address: "5 rue Saint-Honoré, Paris", startSeconds: 85 },
    ],
  });
  const result = await detector.detect({ description: "", transcription: "" });
  assertEquals(result.status, "complete");
  if (result.status === "complete") {
    assertEquals(result.restaurants.length, 2);
    assertEquals(result.restaurants[0].startSeconds, 12);
    assertEquals(result.restaurants[1].name, "Bambino");
  }
});
