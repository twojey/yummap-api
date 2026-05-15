# Worker Yummap : Deno + yt-dlp + gallery-dl + ffmpeg.
# Tourne le pipeline d'import video en mode DEPLOY_MODE=worker.
#
# Sur Railway le build est detecte auto via ce Dockerfile a la racine.
# Les env vars (SUPABASE_*, OPENAI_API_KEY, INSTAGRAM_COOKIES_B64, etc.)
# sont injectees au runtime via le dashboard Railway, pas dans l'image.

FROM denoland/deno:2.4.2

# Outils systeme.
# - ffmpeg : extraction audio + remux video.
# - python3 + pipx : pour installer yt-dlp et gallery-dl avec isolation venv
#   (Debian 12 base de denoland/deno applique PEP 668 = pip --break-needed).
# - ca-certificates : HTTPS sortant (Supabase, OpenAI, Telegram).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    pipx \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"
RUN pipx install yt-dlp && pipx install gallery-dl

WORKDIR /app

# Copy les manifests d'abord pour profiter du cache Docker quand seul le
# code change (les deps sont stables, le cache reste valide).
COPY deno.json deno.lock ./

# Preload toutes les deps Deno. Si server.ts importe quoi que ce soit, c'est
# resolu maintenant et cache dans /deno-dir → boot rapide en prod.
COPY . .
RUN deno cache server.ts

ENV DEPLOY_MODE=worker
EXPOSE 8000

# Railway injecte PORT au runtime. Notre server.ts lit config.port qui lit
# Deno.env.get("PORT"), donc no-op cote code.
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-run", "server.ts"]
