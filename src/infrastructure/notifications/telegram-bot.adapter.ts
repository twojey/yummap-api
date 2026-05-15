/// Envoie des messages d'alerte admin via un bot Telegram.
///
/// Cible : un seul chat (DM avec toi-meme via @BotFather). Pas conçu pour
/// notifier des users finaux — pour ça on a FCM.
///
/// Config via env :
///   TELEGRAM_BOT_TOKEN     : token donne par @BotFather (format 123:ABC...)
///   TELEGRAM_ADMIN_CHAT_ID : id numerique du chat (recupere via getUpdates)
///
/// Si l'une des 2 vars manque, send() devient un no-op silencieux (avec un
/// warn une seule fois) — ca evite de faire planter le worker quand la config
/// est incomplete en local.
export class TelegramBotAdapter {
  #botToken: string;
  #chatId: string;
  #warnedMissing = false;

  constructor() {
    this.#botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    this.#chatId = Deno.env.get("TELEGRAM_ADMIN_CHAT_ID") ?? "";
  }

  isConfigured(): boolean {
    return this.#botToken.length > 0 && this.#chatId.length > 0;
  }

  async send(text: string): Promise<void> {
    if (!this.isConfigured()) {
      if (!this.#warnedMissing) {
        console.warn("[Telegram] TELEGRAM_BOT_TOKEN ou TELEGRAM_ADMIN_CHAT_ID absent, alertes ignorees");
        this.#warnedMissing = true;
      }
      return;
    }

    const url = `https://api.telegram.org/bot${this.#botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.#chatId,
        text,
        parse_mode: "Markdown",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Telegram] send failed (${res.status}): ${body}`);
    }
  }
}
