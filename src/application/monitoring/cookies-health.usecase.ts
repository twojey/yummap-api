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
      const authLike = failures.filter((r) => isCookieAuthSignature(r.error_message)).length;
      const ratio = authLike / failures.length;
      if (ratio >= this.opts.authFailureRatio) {
        console.log(
          `[Health] cookies alert: ${authLike}/${failures.length} failures look auth-related (${(ratio * 100).toFixed(0)}%)`,
        );
        // Échantillon de l'erreur la plus fréquente (parmi les auth-like) pour
        // que l'admin juge tout de suite si c'est une vraie alerte cookies ou
        // un faux positif (ex: tests, URLs mortes).
        const errorSample = mostCommonPrefix(
          failures
            .filter((r) => isCookieAuthSignature(r.error_message))
            .map((f) => f.error_message ?? "(no message)"),
        );
        await this.notifications.dispatch({
          type: "CookiesAuthAlert",
          failedCount: authLike,
          totalCount: failures.length,
          errorSample,
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

/// Détecte une signature d'expiration cookies / login requis dans un message
/// d'erreur de downloader. On exige un vrai signal d'auth (login, 403,
/// challenge, checkpoint…). Le `not_found` ne compte QUE s'il vient de
/// yt-dlp/gallery-dl (Instagram déguise parfois une page login en 404) — PAS
/// du http-fallback, dont le `not_found` est générique (dernier recours qui
/// ne trouve pas la vidéo) et provoquait des fausses alertes cookies.
function isCookieAuthSignature(errorMessage: string | null): boolean {
  const msg = (errorMessage ?? "").toLowerCase();
  if (!msg) return false;
  const authSignals = [
    "auth", "login", "403", "challenge", "checkpoint",
    "not logged", "session", "rate-limit reached",
  ];
  if (authSignals.some((s) => msg.includes(s))) return true;
  // not_found "upstream" (yt-dlp/gallery-dl) = potentielle page login déguisée.
  const isUpstreamNotFound = msg.includes("not_found") &&
    (msg.includes("[yt-dlp]") || msg.includes("[gallery-dl]"));
  return isUpstreamNotFound;
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
