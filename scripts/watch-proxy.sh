#!/bin/bash
# watch-proxy.sh - Caddy proxy health monitor for Prestige Build Pro
# Install: copy to /root/watch-proxy.sh and add to crontab:
# */5 * * * * /root/watch-proxy.sh >> /var/log/watch-proxy.log 2>&1

APP_URL="${APP_URL:-http://localhost:3000}"
CONTAINER_NAME="${CONTAINER_NAME:-prestige-build-pro}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/prestige-build-pro/docker-compose.yml}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Check if the app is responding
check_health() {
  local response
  response=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$APP_URL/health" 2>/dev/null)
  
  if [ "$response" = "200" ]; then
    return 0
  else
    return 1
  fi
}

# Restart the container if needed
restart_container() {
  log "Attempting to restart container $CONTAINER_NAME..."
  
  if [ -f "$COMPOSE_FILE" ]; then
    cd "$(dirname "$COMPOSE_FILE")" || exit 1
    docker compose down
    docker compose up -d
  else
    docker restart "$CONTAINER_NAME"
  fi
  
  # Wait for container to start
  sleep 10
  
  # Check if restart was successful
  if check_health; then
    log "Container restarted successfully."
    return 0
  else
    log "Container restart failed. Manual intervention required."
    return 1
  fi
}

# Reload Caddy if needed
reload_caddy() {
  log "Reloading Caddy..."
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || systemctl reload caddy 2>/dev/null
}

# Main check
main() {
  if check_health; then
    log "Health check passed."
    exit 0
  fi
  
  log "Health check failed. Starting recovery..."
  
  # First, try reloading Caddy
  reload_caddy
  sleep 5
  
  if check_health; then
    log "Recovery successful after Caddy reload."
    exit 0
  fi
  
  # If still failing, restart the container
  restart_container
  
  if check_health; then
    log "Recovery successful after container restart."
    exit 0
  fi
  
  log "Recovery failed. Please check manually."
  exit 1
}

main
