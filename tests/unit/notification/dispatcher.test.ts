import { assertEquals } from "@std/assert";
import type { IPushProvider, PushMessage, PushSendResult } from "../../../src/domain/notification/push.provider.ts";
import type { NotificationEvent } from "../../../src/domain/notification/notification.events.ts";

class SpyPushProvider implements IPushProvider {
  calls: Array<{ tokens: string[]; message: PushMessage }> = [];

  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    this.calls.push({ tokens, message });
    return { successCount: tokens.length, failureCount: 0, invalidTokens: [] };
  }
}

Deno.test("IPushProvider: spy enregistre les appels send", async () => {
  const provider = new SpyPushProvider();
  await provider.send(["token-abc"], { title: "Test", body: "corps" });
  assertEquals(provider.calls.length, 1);
  assertEquals(provider.calls[0].tokens, ["token-abc"]);
  assertEquals(provider.calls[0].message.title, "Test");
});

Deno.test("NotificationEvent: union types bien formés", () => {
  const events: NotificationEvent[] = [
    { type: "NewVideo", influencerId: "a", videoId: "b", restaurantId: "c" },
    { type: "NewGuide", influencerId: "a", guideId: "b" },
    { type: "ImportComplete", userId: "a", videoId: "b", restaurantId: "c" },
    { type: "ImportFailed", userId: "a", videoUrl: "http://tiktok.com/x", missing: ["name"] },
  ];
  assertEquals(events.length, 4);
});
