import { supabaseService } from "../../../config.ts";
import type { INotificationDispatcher } from "../../domain/notification/notification.dispatcher.ts";

/// Surveille la sante de la cascade de telechargement Instagram.
///
/// Heuristique : les cookies IG meurent ~tous les 1-3 mois. Quand ils
/// expirent, yt-dlp/gallery-dl repondent `auth` et le http-fallback voit
/// une page de login (donc `not_found` cote og:video). On detecte ce
/// pattern sur les jobs `failed` recents et on envoie une push aux admins.
///
/// Pas de seuil minimal en plus de l'effectif : 3 fails dont 70% auth-like
/// sur 1h glissante est suffisant pour confirmer (les faux positifs typiques
/// — URL invalide, video supprimee — ne tombent pas sur "auth"/"not_found").
export class CookiesHealthMonitor {
  // Persiste entre les ticks, reset au restart worker. Suffit pour eviter
  // de spammer 6x/h une fois l'alerte declenchee.
  #lastAlertAt: Date | null = null;

  constructor(
    private readonly notifications: INotificationDispatcher,
    private readonly opts: {
      windowMinutes: number;
      minFailures: number;
      authFailureRatio: number;
      cooldownHours: number;
    } = {
      windowMinutes: 60,
      minFailures: 3,
      authFailureRatio: 0.7,
      cooldownHours: 6,
    },
  ) {}

  async checkAndAlert(): Promise<void> {
    if (this.#inCooldown()) return;

    const cutoff = new Date(Date.now() - this.opts.windowMinutes * 60_000).toISOString();
    const { data, error } = await supabaseService
      .from("video_import_requests")
      .select("error_message")
      .eq("status", "failed")
      .gte("created_at", cutoff);
    if (error) {
      console.error("[CookiesHealth] query failed:", error.message);
      return;
    }

    const failures = data ?? [];
    if (failures.length < this.opts.minFailures) return;

    const authLike = failures.filter((r: { error_message: string | null }) => {
      const msg = (r.error_message ?? "").toLowerCase();
      return msg.includes("auth") || msg.includes("not_found");
    }).length;

    const ratio = authLike / failures.length;
    if (ratio < this.opts.authFailureRatio) return;

    console.log(
      `[CookiesHealth] alerting: ${authLike}/${failures.length} failures look auth-related (${(ratio * 100).toFixed(0)}%)`,
    );
    await this.notifications.dispatch({
      type: "CookiesAuthAlert",
      failedCount: authLike,
      totalCount: failures.length,
    });
    this.#lastAlertAt = new Date();
  }

  #inCooldown(): boolean {
    if (!this.#lastAlertAt) return false;
    const elapsedMs = Date.now() - this.#lastAlertAt.getTime();
    return elapsedMs < this.opts.cooldownHours * 3600_000;
  }
}
