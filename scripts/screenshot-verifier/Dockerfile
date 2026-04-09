# Screenshot Verifier — isolated Playwright container for visual health checks.
# Used by Prestige Build's runtime verification to detect white screens, JS errors,
# and runtime crashes that static checks (back-test, coherence) cannot catch.
#
# This container is OPTIONAL and only built when ENABLE_VISUAL_VERIFY=true is set
# on the main Prestige server. It joins the pbp-projects Docker network so it can
# resolve project containers by DNS.
#
# Build: docker build -t pbp-screenshot-verifier scripts/screenshot-verifier/
# Run:   docker run -d --name pbp-screenshot-verifier --network pbp-projects -p 4000:4000 pbp-screenshot-verifier
#
# Why a separate container vs running in pbp-server:
# - Chromium binary is 250MB+ and adds attack surface to the main server
# - Isolated crash domain (a Playwright OOM doesn't kill Prestige)
# - Can scale independently if needed (e.g., 2 verifier replicas behind a queue)
# - Uses the official Microsoft Playwright image (Debian-based) which is the only
#   reliably-working Playwright environment (Alpine has known musl libc issues)

FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Install only what we need — the base image already has chromium, firefox, webkit
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

EXPOSE 4000
USER pwuser

CMD ["node", "index.js"]
