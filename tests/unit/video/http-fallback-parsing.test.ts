import { assertEquals } from "@std/assert";
import { extractVideoUrlFromHtml } from "../../../src/infrastructure/video/instagram-html-parsing.ts";

// Tests purs sur le parsing du HTML Instagram. Pas d'I/O réseau, pas de
// dépendance Deno.Command : exécutables sans yt-dlp/ffmpeg installés.

Deno.test("http parsing: og:video extrait l'URL CDN", () => {
  const html = `
    <html>
      <head>
        <meta property="og:title" content="Cool reel" />
        <meta property="og:video" content="https://scontent.cdninstagram.com/v/123.mp4?token=xyz" />
      </head>
    </html>
  `;
  assertEquals(
    extractVideoUrlFromHtml(html),
    "https://scontent.cdninstagram.com/v/123.mp4?token=xyz",
  );
});

Deno.test("http parsing: og:video:secure_url fallback si og:video absent", () => {
  const html = `
    <meta property="og:video:secure_url" content="https://example.com/secure.mp4" />
  `;
  assertEquals(extractVideoUrlFromHtml(html), "https://example.com/secure.mp4");
});

Deno.test("http parsing: og:video prioritaire sur secure_url quand les deux présents", () => {
  const html = `
    <meta property="og:video" content="https://a.com/v.mp4" />
    <meta property="og:video:secure_url" content="https://b.com/v.mp4" />
  `;
  assertEquals(extractVideoUrlFromHtml(html), "https://a.com/v.mp4");
});

Deno.test("http parsing: video_url JSON inline (fallback quand meta absente)", () => {
  const html = `
    <script>window.data = {"video_url":"https:\\/\\/cdninstagram.com\\/v\\/test.mp4"}</script>
  `;
  assertEquals(
    extractVideoUrlFromHtml(html),
    "https://cdninstagram.com/v/test.mp4",
  );
});

Deno.test("http parsing: décode &amp; dans les URLs (Instagram HTML-encode les & des params)", () => {
  const html = `
    <meta property="og:video" content="https://cdn.com/v.mp4?a=1&amp;b=2&amp;c=3" />
  `;
  assertEquals(
    extractVideoUrlFromHtml(html),
    "https://cdn.com/v.mp4?a=1&b=2&c=3",
  );
});

Deno.test("http parsing: HTML sans video → null", () => {
  const html = `<html><head><title>Just text</title></head></html>`;
  assertEquals(extractVideoUrlFromHtml(html), null);
});

Deno.test("http parsing: insensible à la casse du tag meta", () => {
  const html = `<META Property="og:video" Content="https://x.com/v.mp4" />`;
  assertEquals(extractVideoUrlFromHtml(html), "https://x.com/v.mp4");
});
