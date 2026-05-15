import { assertEquals, assertRejects } from "@std/assert";
import {
  type DownloadResult,
  DownloaderError,
  type IVideoDownloader,
} from "../../../src/domain/video/video-downloader.ts";
import { CascadingDownloader } from "../../../src/infrastructure/video/downloaders/cascading-downloader.ts";

class FakeDownloader implements IVideoDownloader {
  callCount = 0;
  constructor(
    readonly name: string,
    private readonly result: DownloadResult | DownloaderError,
  ) {}
  async download(_url: string): Promise<DownloadResult> {
    this.callCount++;
    if (this.result instanceof DownloaderError) throw this.result;
    return this.result;
  }
}

const okResult = (adapter: string): DownloadResult => ({
  videoPath: `/tmp/${adapter}.mp4`,
  audioPath: `/tmp/${adapter}.mp3`,
  postedAt: null,
  externalPostId: "abc",
  platform: "instagram",
});

Deno.test("cascading: 1er adapter OK → on s'arrête là", async () => {
  const a = new FakeDownloader("A", okResult("A"));
  const b = new FakeDownloader("B", okResult("B"));
  const cascade = new CascadingDownloader([a, b]);

  const r = await cascade.download("https://instagram.com/p/x/");
  assertEquals(r.videoPath, "/tmp/A.mp4");
  assertEquals(a.callCount, 1);
  assertEquals(b.callCount, 0);
});

Deno.test("cascading: 1er échoue download_failed → fallback sur le suivant", async () => {
  const a = new FakeDownloader("A", new DownloaderError("download_failed", "A", "boom"));
  const b = new FakeDownloader("B", okResult("B"));
  const cascade = new CascadingDownloader([a, b]);

  const r = await cascade.download("https://instagram.com/p/x/");
  assertEquals(r.videoPath, "/tmp/B.mp4");
  assertEquals(a.callCount, 1);
  assertEquals(b.callCount, 1);
});

Deno.test("cascading: unsupported_url ne compte pas comme échec, passe au suivant", async () => {
  const a = new FakeDownloader("A", new DownloaderError("unsupported_url", "A", "not for me"));
  const b = new FakeDownloader("B", okResult("B"));
  const cascade = new CascadingDownloader([a, b]);

  const r = await cascade.download("https://tiktok.com/@u/video/1");
  assertEquals(r.videoPath, "/tmp/B.mp4");
});

Deno.test("cascading: tool_missing passe au suivant sans crash", async () => {
  const a = new FakeDownloader("A", new DownloaderError("tool_missing", "A", "yt-dlp not installed"));
  const b = new FakeDownloader("B", okResult("B"));
  const cascade = new CascadingDownloader([a, b]);

  const r = await cascade.download("https://instagram.com/p/x/");
  assertEquals(r.videoPath, "/tmp/B.mp4");
});

Deno.test("cascading: tous échouent → throw la dernière vraie erreur", async () => {
  const a = new FakeDownloader("A", new DownloaderError("auth", "A", "login required"));
  const b = new FakeDownloader("B", new DownloaderError("not_found", "B", "404"));
  const cascade = new CascadingDownloader([a, b]);

  await assertRejects(
    () => cascade.download("https://instagram.com/p/x/"),
    DownloaderError,
    "not_found",
  );
});

Deno.test("cascading: tous unsupported → throw unsupported_url global", async () => {
  const a = new FakeDownloader("A", new DownloaderError("unsupported_url", "A", "nope"));
  const b = new FakeDownloader("B", new DownloaderError("unsupported_url", "B", "nope"));
  const cascade = new CascadingDownloader([a, b]);

  const err = await assertRejects(
    () => cascade.download("https://random.com/x"),
    DownloaderError,
  );
  assertEquals(err.kind, "unsupported_url");
});

Deno.test("cascading: ordre respecté — A puis B puis C", async () => {
  const calls: string[] = [];
  const make = (name: string, result: DownloadResult | DownloaderError) => {
    return {
      name,
      async download() {
        calls.push(name);
        if (result instanceof DownloaderError) throw result;
        return result;
      },
    } satisfies IVideoDownloader;
  };
  const cascade = new CascadingDownloader([
    make("A", new DownloaderError("download_failed", "A", "x")),
    make("B", new DownloaderError("download_failed", "B", "y")),
    make("C", okResult("C")),
  ]);

  await cascade.download("https://instagram.com/p/x/");
  assertEquals(calls, ["A", "B", "C"]);
});

Deno.test("cascading: au moins un adapter requis", () => {
  try {
    new CascadingDownloader([]);
    throw new Error("should have thrown");
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("at least one")) throw e;
  }
});
