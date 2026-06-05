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
# curl_cffi est injecté dans le venv yt-dlp : permet a yt-dlp d'imiter le
# TLS fingerprint d'un Chrome reel. TikTok bloque sinon les requêtes avec
# "Your IP address is blocked" (en realite : fingerprint Python detecte).
RUN pipx install yt-dlp \
    && pipx inject yt-dlp curl_cffi \
    && pipx install gallery-dl

WORKDIR /app

# Copy les manifests d'abord pour profiter du cache Docker quand seul le
# code change (les deps sont stables, le cache reste valide).
COPY deno.json deno.lock ./

# Cache-bust : changer cette valeur force le rebuild de tout ce qui suit
# (COPY du code + deno cache), contournant un cache d'image obstiné côté HF.
ARG CACHE_BUST=2026-06-05-2
RUN echo "build ${CACHE_BUST}"

COPY . .

ENV DEPLOY_MODE=worker
EXPOSE 8000

# --reload : deno ignore tout cache de transpilation et re-lit le code source à
# chaque démarrage → garantit que le code à jour s'exécute (pas une version
# figée par un cache de build). Les deps sont re-résolues au 1er boot.
CMD ["deno", "run", "--reload", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-run", "server.ts"]
