import { config } from "../../../config.ts";
import type { ITranscriptionService } from "../../domain/video/video.pipeline.ts";

export class WhisperTranscriptionAdapter implements ITranscriptionService {
  async transcribe(audioPath: string): Promise<{ text: string; vttPath: string }> {
    const audioBytes = await Deno.readFile(audioPath);
    const formData = new FormData();
    formData.append("file", new Blob([audioBytes], { type: "audio/mpeg" }), "audio.mp3");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Whisper API error: ${response.status} ${await response.text()}`);
    }

    const result = await response.json() as { text: string; segments: Array<{ start: number; end: number; text: string }> };

    const vttPath = audioPath.replace(/\.[^.]+$/, ".vtt");
    const vttContent = this.#buildVtt(result.segments);
    await Deno.writeTextFile(vttPath, vttContent);

    return { text: result.text, vttPath };
  }

  #buildVtt(segments: Array<{ start: number; end: number; text: string }>): string {
    const ts = (s: number) => {
      const h = Math.floor(s / 3600).toString().padStart(2, "0");
      const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
      const sec = (s % 60).toFixed(3).padStart(6, "0");
      return `${h}:${m}:${sec}`;
    };
    const cues = segments.map((seg, i) =>
      `${i + 1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${seg.text.trim()}`
    );
    return `WEBVTT\n\n${cues.join("\n\n")}`;
  }
}
