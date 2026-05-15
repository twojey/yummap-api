import { loadEnv } from "./deps.ts";
import { createClient, type SupabaseClient } from "./deps.ts";

// loadEnv lit le `.env` local (dev/test). Sur Deno Deploy il n'y a pas de
// fichier `.env` ni d'accès filesystem, mais les variables sont injectées
// directement dans `Deno.env` via le dashboard — donc on rend l'import safe
// au lieu de planter au boot.
try {
  await loadEnv({ export: true });
} catch (_) {
  // ENOENT (.env absent) ou PermissionDenied (Deno Deploy sandbox).
  // On continue : les variables seront lues depuis Deno.env directement.
}

const required = (key: string): string => {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

const optional = (key: string, fallback = ""): string =>
  Deno.env.get(key) ?? fallback;

export const config = {
  port: Number(optional("PORT", "8000")),
  env: optional("DENO_ENV", "development"),
  // Mode de déploiement :
  //   - "api"    : Deno Deploy. Routes HTTP seulement, pas de schedulers,
  //                pas d'exécution sync du pipeline. /videos/import enqueue
  //                un job et retourne 202 immédiatement.
  //   - "worker" : VM (Fly.io/Railway). Schedulers ON, pipeline ON. Pas
  //                besoin d'exposer les routes mais on les garde pour les
  //                tests locaux.
  //   - "all"    : Dev local (default). Tout activé dans un seul process.
  deployMode: (optional("DEPLOY_MODE", "all") as "api" | "worker" | "all"),
  supabase: {
    url: optional("SUPABASE_URL", "https://example.com"),
    serviceRoleKey: optional("SUPABASE_SERVICE_ROLE_KEY", "service_role_test_key"),
    anonKey: optional("SUPABASE_ANON_KEY", "anon_test_key"),
  },
  googlePlaces: {
    apiKey: optional("GOOGLE_PLACES_API_KEY"),
  },
  openai: {
    apiKey: optional("OPENAI_API_KEY"),
  },
  gemini: {
    apiKey: optional("GEMINI_API_KEY"),
  },
  groq: {
    apiKey: optional("GROQ_API_KEY"),
  },
  fcm: {
    projectId: optional("FCM_PROJECT_ID"),
    serviceAccountKey: optional("FCM_SERVICE_ACCOUNT_KEY"),
  },
  videoStorage: {
    basePath: optional("VIDEO_STORAGE_PATH", "/tmp/yummap_videos"),
    baseUrl: optional("VIDEO_STORAGE_URL", "http://localhost:8000/videos"),
  },
  r2: {
    accountId: optional("R2_ACCOUNT_ID"),
    accessKeyId: optional("R2_ACCESS_KEY_ID"),
    secretAccessKey: optional("R2_SECRET_ACCESS_KEY"),
    bucket: optional("R2_BUCKET", "yummap-videos"),
    // URL publique du bucket R2 (configurée dans le dashboard Cloudflare)
    publicBaseUrl: optional("R2_PUBLIC_BASE_URL", ""),
  },
} as const;

export const supabaseService: SupabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const supabaseAnon: SupabaseClient = createClient(
  config.supabase.url,
  config.supabase.anonKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
