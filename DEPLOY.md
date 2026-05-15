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
| `INSTAGRAM_COOKIES_B64`        | Cookies Instagram en base64 — voir section dédiée plus bas.|

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
[app.deno.com](https://app.deno.com) → projet `yummap-api` → onglet Logs (live tail).

---

## 🍪 Cookies Instagram

Le téléchargement de Reels/posts Instagram nécessite un cookie de session
valide. Les cookies de session **expirent** au bout de ~30-90 jours et il faut
les régénérer périodiquement.

### Cascade de téléchargement

Pour résilience, le worker essaie 3 méthodes en cascade :

| Niveau | Outil           | Cookies requis ? |
| ------ | --------------- | ---------------- |
| 1      | `yt-dlp`        | Oui pour la plupart des Reels |
| 2      | `gallery-dl`    | Oui (parse une API différente)|
| 3      | Fetch HTTP direct + parse `og:video` meta | Non, mais ne marche que pour les posts publics indexés |

Quand le cookie expire, les niveaux 1 et 2 retournent `auth` → le niveau 3
prend la suite. La cascade tient quelques jours sans cookies valide, mais la
qualité dégrade : refresh-les dès que tu reçois une alerte.

### Étape 1 — Extraire les cookies depuis un browser

Le format attendu est **Netscape `cookies.txt`** (le même que celui que `curl
--cookie` consomme).

Extensions à utiliser :
- Chrome / Edge : **"Get cookies.txt LOCALLY"** (open source, à privilégier ;
  les extensions closed-source peuvent exfiltrer).
- Firefox : **"cookies.txt"** par lennon.

Procédure :

1. Sur ton navigateur, va sur https://www.instagram.com et **connecte-toi** à un compte burner (pas ton compte perso, au cas où IG flag l'activité).
2. Reste sur instagram.com, clique sur l'extension, **Export → cookies.txt**.
3. Sauvegarde le fichier sous `.instagram-cookies.txt` à la racine du repo (ignoré par git).

### Étape 2 — Pousser sur le worker

```bash
# Encode le fichier en base64 (mac/linux)
base64 -i .instagram-cookies.txt | tr -d '\n' | pbcopy
```

(`pbcopy` met le résultat dans le presse-papier macOS. Sur Linux remplace par `xclip -selection clipboard`.)

Puis :

**Fly.io** :
```bash
fly secrets set INSTAGRAM_COOKIES_B64='<paste>' --app yummap-worker
# Restart automatique de l'instance après ce set.
```

**Railway / Render / autre** :
Va dans le dashboard → Environment variables → ajoute `INSTAGRAM_COOKIES_B64` avec le contenu copié.

### Étape 3 — Vérifier que ça marche

```bash
# Sur le worker, dans les logs de démarrage :
[InstagramCookies] cookies materialised at /tmp/instagram-cookies.txt
```

Puis lance un import test :
```bash
curl -X POST https://yummap-api.deno.dev/videos/import \
  -H 'Authorization: Bearer <token>' \
  -d '{"url":"https://www.instagram.com/reel/<id>/"}'
```

Suis le statut. Si tu vois `auth` dans les logs worker, le cookie n'est plus
valide → ré-extraire (étape 1).

### Étape 4 — Rotation

Pas d'automatisation aujourd'hui. À la prochaine itération, on peut :

- Monitor le taux d'erreurs `auth` sur les jobs `video_import_requests`.
- Si > 10% sur les 24h, envoyer un push notif à l'admin.
- Re-extraire le cookie depuis le browser, recopier dans le secret manager.
