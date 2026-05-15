import { supabaseService } from "../../../config.ts";
import type { INotificationDispatcher } from "../../domain/notification/notification.dispatcher.ts";

/// Surveille la sante de la cascade de telechargement (Instagram, TikTok, etc).
///
/// Deux signatures distinctes, jamais les deux alertes en meme temps :
///
///   1. Cookies Instagram expires : >=70% des fails sur 1h ont une signature
///      "auth" ou "not_found". yt-dlp/gallery-dl renvoient auth, http-fallback
///      tombe sur "not_found" (page login). Action user : regenerer cookies.
///
///   2. Echec generique : >=5 fails ET >=70% du total des imports recents
///      ont echoue, sans signature cookies. TikWm down, OpenAI quota mort,
///      Supabase indisponible, bug deploy. Action user : check logs Railway.
///
/// Cooldown 6h en memoire : evite de spammer une fois l'alerte tiree.
/// Le compteur reset au restart worker — acceptable (le worker reste up).
export class CookiesHealthMonitor {
  #lastAlertAt: Date | null = null;

  constructor(
    private readonly notifications: INotificationDispatcher,
    private readonly opts: {
      windowMinutes: number;
      minFailuresForCookies: number;
      minFailuresForGeneric: number;
      authFailureRatio: number;
      genericFailureRatio: number;
      cooldownHours: number;
    } = {
      windowMinutes: 60,
      minFailuresForCookies: 3,
      minFailuresForGeneric: 5,
      authFailureRatio: 0.7,
      genericFailureRatio: 0.7,
      cooldownHours: 6,
    },
  ) {}

  async checkAndAlert(): Promise<void> {
    if (this.#inCooldown()) return;

    const cutoff = new Date(Date.now() - this.opts.windowMinutes * 60_000).toISOString();
    const { data, error } = await supabaseService
      .from("video_import_requests")
      .select("status, error_message")
      .gte("created_at", cutoff);
    if (error) {
      console.error("[Health] query failed:", error.message);
      return;
    }

    const rows = (data ?? []) as Array<{ status: string; error_message: string | null }>;
    const failures = rows.filter((r) => r.status === "failed");

    // --- 1. Cookies Instagram --------------------------------------------
    if (failures.length >= this.opts.minFailuresForCookies) {
      const authLike = failures.filter((r) => {
        const msg = (r.error_message ?? "").toLowerCase();
        return msg.includes("auth") || msg.includes("not_found");
      }).length;
      const ratio = authLike / failures.length;
      if (ratio >= this.opts.authFailureRatio) {
        console.log(
          `[Health] cookies alert: ${authLike}/${failures.length} failures look auth-related (${(ratio * 100).toFixed(0)}%)`,
        );
        await this.notifications.dispatch({
          type: "CookiesAuthAlert",
          failedCount: authLike,
          totalCount: failures.length,
        });
        this.#lastAlertAt = new Date();
        return;
      }
    }

    // --- 2. Echec generique -----------------------------------------------
    // On regarde le ratio des fails sur le total des imports recents (pas
    // sur les failures seules), pour pas alerter quand l'user importe 3
    // URLs mortes alors que tout le reste tourne bien.
    if (failures.length >= this.opts.minFailuresForGeneric && rows.length > 0) {
      const ratio = failures.length / rows.length;
      if (ratio >= this.opts.genericFailureRatio) {
        // Echantillon d'erreur = errorMessage le plus frequent (en prefixe
        // d'adapter ex "[tikwm] download_failed: ...").
        const sample = mostCommonPrefix(
          failures.map((f) => f.error_message ?? "(no message)"),
        );
        console.log(
          `[Health] generic alert: ${failures.length}/${rows.length} imports failed (${(ratio * 100).toFixed(0)}%)`,
        );
        await this.notifications.dispatch({
          type: "PipelineFailureAlert",
          failedCount: failures.length,
          totalCount: rows.length,
          topErrorSample: sample,
        });
        this.#lastAlertAt = new Date();
      }
    }
  }

  #inCooldown(): boolean {
    if (!this.#lastAlertAt) return false;
    const elapsedMs = Date.now() - this.#lastAlertAt.getTime();
    return elapsedMs < this.opts.cooldownHours * 3600_000;
  }
}

/// Renvoie le prefixe le plus frequent (premiers 80 chars) des messages
/// d'erreur, pour donner un sample lisible dans l'alerte Telegram. Les
/// messages d'un meme adapter commencent par "[adapter] kind: ...", donc
/// le prefixe est assez discriminant.
function mostCommonPrefix(messages: string[]): string {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const key = m.slice(0, 80);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [k, n] of counts) {
    if (n > bestCount) {
      best = k;
      bestCount = n;
    }
  }
  return best;
}
