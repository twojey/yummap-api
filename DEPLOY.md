# Déploiement Yummap Backend

L'API est découpée en **deux process** :

| Process    | Plateforme            | Rôle                                                       |
| ---------- | --------------------- | ---------------------------------------------------------- |
| **api**    | Deno Deploy           | Routes HTTP. Pas de pipeline, pas de schedulers.           |
| **worker** | Fly.io / Railway / VM | Pipeline vidéo (yt-dlp, ffmpeg, Whisper) + schedulers.     |

Cette séparation est imposée par les limites de Deno Deploy (pas de
`Deno.Command`, pas d'accès filesystem, pas de `setInterval` long-running).
Les deux process partagent la même DB Supabase et la même queue
`video_import_requests`.

---

## 🔑 Variables d'environnement

Les mêmes variables sont consommées partout — seule `DEPLOY_MODE` diffère.

### Communes

| Variable                       | Description                                                |
| ------------------------------ | ---------------------------------------------------------- |
| `DEPLOY_MODE`                  | `api` (Deno Deploy), `worker` (VM), `all` (dev local).     |
| `DENO_ENV`                     | `production` / `staging` / `development`.                  |
| `SUPABASE_URL`                 | URL projet Supabase.                                       |
| `SUPABASE_SERVICE_ROLE_KEY`    | Service role (bypasses RLS). À ne **jamais** exposer côté client. |
| `SUPABASE_ANON_KEY`            | Anon key (RLS appliquée).                                  |
| `GOOGLE_PLACES_API_KEY`        | Clé Google Places (lecture + détails).                     |
| `OPENAI_API_KEY`               | OpenAI (Whisper transcription, GPT fallback détection).    |
| `GEMINI_API_KEY`               | Google Gemini (détection resto prioritaire 2).             |
| `GROQ_API_KEY`                 | Groq (détection resto prioritaire 1, 1000 req/jour gratuit).|
| `FCM_PROJECT_ID`               | Projet Firebase Cloud Messaging.                           |
| `FCM_SERVICE_ACCOUNT_KEY`      | JSON service account FCM (string brute, pas chemin).       |

### Uniquement côté worker (mode `worker` ou `all`)

| Variable                  | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `VIDEO_STORAGE_PATH`      | Path local pour les vidéos temporaires avant upload.       |
| `VIDEO_STORAGE_URL`       | Base URL publique des vidéos (si on garde du local).       |
| `R2_ACCOUNT_ID`           | Compte Cloudflare R2.                                      |
| `R2_ACCESS_KEY_ID`        | Access key R2.                                             |
| `R2_SECRET_ACCESS_KEY`    | Secret R2.                                                 |
| `R2_BUCKET`               | Nom du bucket (default `yummap-videos`).                   |
| `R2_PUBLIC_BASE_URL`      | URL publique du bucket R2.                                 |

---

## 🚀 Deno Deploy (mode `api`)

### Première mise en place

1. Sur [dash.deno.com](https://dash.deno.com), créer un projet **`yummap-api`** (Empty Project).
2. Settings → Environment Variables → ajouter toutes les vars **Communes** ci-dessus + `DEPLOY_MODE=api`.
3. Générer un **Access Token** dans Account → Access Tokens.
4. Sur GitHub : Settings → Secrets → Actions → ajouter `DENO_DEPLOY_TOKEN`.
5. Push sur `main` → le workflow `.github/workflows/deploy.yml` déploie.

L'API sera servie sur `https://yummap-api.deno.dev`.

### Déploiement manuel ponctuel

```bash
# Depuis le repo yummap_backend
deno install -gArf jsr:@deno/deployctl
deployctl deploy --project=yummap-api --entrypoint=server.ts
```

### Vérifier que ça tourne

```bash
curl https://yummap-api.deno.dev/health
# → {"status":"ok","env":"production"}
```

---

## 🛠️ Worker (mode `worker`, Fly.io recommandé)

À mettre en place dans une itération séparée. Le worker doit :
- Avoir `yt-dlp` et `ffmpeg` installés
- Avoir accès écriture au `VIDEO_STORAGE_PATH`
- Configurer `DEPLOY_MODE=worker`
- Démarrer avec `deno task start`

Les schedulers vont :
- Poller `video_import_requests` pour les jobs `pending` non encore traités par cette instance et lancer le pipeline.
- Backfill Google Places sur les restos sans `opening_hours`.

---

## 🧪 Dev local (mode `all`)

```bash
cp .env.example .env
# Remplir les vars
deno task start:dev
```

En `all`, le même process héberge l'API ET le pipeline ET les schedulers.
Aucun découpage à faire.

---

## ❓ FAQ

**Q : Si quelqu'un déclenche un import sur Deno Deploy avant que le worker soit en ligne ?**
Le job est créé en `pending` dans Supabase et y reste. Dès qu'un worker démarre, son scheduler pickera tous les jobs en `pending`. L'app cliente reverra le statut `pending` à chaque poll.

**Q : Le mode `api` peut-il quand même servir `/health` et les routes lecture ?**
Oui — toutes les routes restent disponibles. Seul `POST /videos/import` (la partie qui lancerait yt-dlp sync) est court-circuitée vers enqueue-only.

**Q : Comment voir les logs du déploiement Deno Deploy ?**
[dash.deno.com](https://dash.deno.com) → projet `yummap-api` → onglet Logs (live tail).
