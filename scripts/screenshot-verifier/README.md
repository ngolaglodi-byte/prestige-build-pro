# Screenshot Verifier (Sprint D — Visual Verification)

Isolated Playwright container that loads project preview pages and reports
white screens, JS console errors, and API failures.

**Status: FEATURE-FLAGGED OFF by default.** No impact on Prestige Build prod
until you manually enable it.

## What it catches

- ✅ Blank/white screens (React mount failures, infinite render loops)
- ✅ JavaScript console errors (`pageerror`, console.error)
- ✅ Failed API requests (4xx/5xx on `/api/*` paths)
- ✅ Navigation timeouts (Vite never compiled, server crashed)

## What it does NOT catch

- ❌ Subjective design problems (it's not an image classifier)
- ❌ Bugs in features that aren't on the home page
- ❌ Logic bugs that don't surface as errors

## Why a separate container

- Chromium binary is 250MB+ — would double the size of pbp-server image
- Isolates crash domain (Playwright OOM doesn't kill main server)
- Uses Microsoft's official Debian-based image (Alpine has musl libc issues)
- Can be scaled independently if needed

## How to enable (production)

1. **Build the verifier image**:
   ```bash
   cd /path/to/prestige-build
   docker build -t pbp-screenshot-verifier scripts/screenshot-verifier/
   ```

2. **Run the verifier on the same Docker network as projects**:
   ```bash
   docker run -d \
     --name pbp-screenshot-verifier \
     --network pbp-projects \
     --restart unless-stopped \
     --memory 1g \
     --cpus 0.5 \
     pbp-screenshot-verifier
   ```

3. **Set the environment variable on pbp-server**:
   ```bash
   ENABLE_VISUAL_VERIFY=true
   VISUAL_VERIFY_URL=http://pbp-screenshot-verifier:4000
   ```

   For Coolify, add these as environment variables on the prestige-build service
   and restart.

4. **Verify it works**:
   ```bash
   curl http://pbp-screenshot-verifier:4000/health
   # Should return {"ok":true,"browser":true|false}
   ```

5. **Trigger a generation** in Prestige Build. The server logs should show:
   ```
   [Visual] verify project=42 ok=true duration=4521ms
   ```

## How to disable (rollback)

```bash
# Set env var to false (or remove it)
ENABLE_VISUAL_VERIFY=false

# Restart pbp-server
# The verifier container can keep running or be stopped:
docker stop pbp-screenshot-verifier
docker rm pbp-screenshot-verifier
```

## API

### `POST /verify`

```json
{
  "url": "http://pbp-project-42:5173/",
  "projectId": 42,
  "timeout": 15000
}
```

Response:

```json
{
  "ok": false,
  "issues": [
    {
      "type": "BLANK_SCREEN",
      "severity": "warning",
      "message": "Likely blank screen: screenshot too small"
    },
    {
      "type": "JS_CONSOLE_ERRORS",
      "severity": "warning",
      "message": "2 JS console error(s)",
      "details": ["TypeError: Cannot read property 'map' of undefined"]
    }
  ],
  "console_errors": [...],
  "network_errors": [...],
  "screenshot_size": 4523,
  "duration_ms": 4521
}
```

### `GET /health`

```json
{ "ok": true, "browser": true }
```

## Cost

- **API:** $0 (no LLM calls — pure pixel/log analysis)
- **Disk:** +250MB Docker image (one-time, isolated container)
- **RAM:** ~500MB peak per concurrent verification (limit to 1GB)
- **Latency:** 4-8s per verification, runs ASYNC (doesn't block user)

## Decision: when to enable

Enable Phase C **after** running Phase B (the AST coherence + HTTP/logs check
in `9ef6ca2`) for 1 week and observing:

- If 5%+ of generations have white-screen bugs the static checks miss → enable
- If 0% → don't bother, you're already good
