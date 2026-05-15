import { supabaseService } from "../../../config.ts";
import type { INotificationDispatcher } from "../../domain/notification/notification.dispatcher.ts";
import type { NotificationEvent } from "../../domain/notification/notification.events.ts";
import type { IPushProvider } from "../../domain/notification/push.provider.ts";
import type { TelegramBotAdapter } from "./telegram-bot.adapter.ts";

export class NotificationDispatcher implements INotificationDispatcher {
  constructor(
    private readonly push: IPushProvider,
    private readonly telegram: TelegramBotAdapter,
  ) {}

  async dispatch(event: NotificationEvent): Promise<void> {
    switch (event.type) {
      case "NewVideo":
        await this.#dispatchToFollowers(event.influencerId, {
          title: "Nouvelle vidéo",
          body: "Un influenceur que tu suis a partagé une nouvelle vidéo",
          data: { type: "NewVideo", videoId: event.videoId, restaurantId: event.restaurantId },
        }, "new_video");
        break;

      case "NewGuide":
        await this.#dispatchToFollowers(event.influencerId, {
          title: "Nouveau Guide",
          body: "Un influenceur que tu suis a créé un nouveau Guide",
          data: { type: "NewGuide", guideId: event.guideId },
        }, "new_guide");
        break;

      case "ImportComplete":
        await this.#dispatchToUser(event.userId, {
          title: "Vidéo importée ✓",
          body: "Ton restaurant a été détecté avec succès",
          data: { type: "ImportComplete", videoId: event.videoId },
        }, "import_complete");
        break;

      case "ImportFailed":
        await this.#dispatchToUser(event.userId, {
          title: "Infos manquantes",
          body: "Complète les informations du restaurant pour finaliser l'import",
          data: { type: "ImportFailed", missing: event.missing.join(",") },
        }, "import_failed");
        break;

      case "CookiesAuthAlert": {
        // Route via Telegram bot (pas FCM) : c'est une alerte admin pour 1-2
        // destinataires fixes, l'app mobile n'a pas besoin d'etre installee.
        await this.telegram.send(
          `⚠️ *Cookies Instagram expirés*\n\n` +
          `${event.failedCount}/${event.totalCount} imports en échec sur la dernière heure.\n\n` +
          `Régénère les cookies depuis ton browser et push le nouveau secret \`INSTAGRAM_COOKIES_B64\` sur le worker. ` +
          `Procédure dans \`DEPLOY.md\` section "Cookies Instagram".`,
        );
        break;
      }
    }
  }

  async #dispatchToFollowers(
    influencerId: string,
    message: { title: string; body: string; data: Record<string, string> },
    notifType: string,
  ): Promise<void> {
    const { data: followers } = await supabaseService
      .from("follows")
      .select("user_id")
      .eq("influencer_id", influencerId);

    if (!followers?.length) return;

    const userIds = followers.map((f: { user_id: string }) => f.user_id);
    await this.#sendToUsers(userIds, message, notifType);
  }

  async #dispatchToUser(
    userId: string,
    message: { title: string; body: string; data: Record<string, string> },
    notifType: string,
  ): Promise<void> {
    await this.#sendToUsers([userId], message, notifType);
  }

  async #sendToUsers(
    userIds: string[],
    message: { title: string; body: string; data: Record<string, string> },
    notifType: string,
  ): Promise<void> {
    // Filtrer les users qui ont activé ce type de notification
    const { data: prefs } = await supabaseService
      .from("notification_preferences")
      .select("user_id, push_token")
      .in("user_id", userIds)
      .eq(`${notifType}_enabled`, true)
      .not("push_token", "is", null);

    if (!prefs?.length) return;

    const tokens = prefs.map((p: { push_token: string }) => p.push_token);
    const result = await this.push.send(tokens, message);

    if (result.invalidTokens.length > 0) {
      await supabaseService
        .from("notification_preferences")
        .update({ push_token: null })
        .in("push_token", result.invalidTokens);
    }
  }
}
