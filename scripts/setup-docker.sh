#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Prestige Build Pro - Docker Setup Script
# ═══════════════════════════════════════════════════════════════════════════
# Run this script once on the server to set up the Docker environment.
# Usage: chmod +x scripts/setup-docker.sh && ./scripts/setup-docker.sh

set -e

echo "═══════════════════════════════════════════════════════════════════"
echo "       Prestige Build Pro - Docker Environment Setup"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

echo "✓ Docker is installed"
docker --version
echo ""

# Create the dedicated network for project containers
NETWORK_NAME="pbp-projects"
if docker network inspect $NETWORK_NAME &> /dev/null; then
    echo "✓ Network '$NETWORK_NAME' already exists"
else
    echo "Creating Docker network '$NETWORK_NAME'..."
    docker network create $NETWORK_NAME
    echo "✓ Network '$NETWORK_NAME' created"
fi
echo ""

# Build the base image
BASE_IMAGE="pbp-base"
echo "Building base image '$BASE_IMAGE'..."
echo "This may take a few minutes on first run..."
echo ""

# Find the Dockerfile.base
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/Dockerfile.base" ]; then
    docker build -t $BASE_IMAGE -f "$PROJECT_DIR/Dockerfile.base" "$PROJECT_DIR"
    echo ""
    echo "✓ Base image '$BASE_IMAGE' built successfully"
else
    echo "❌ Dockerfile.base not found at $PROJECT_DIR/Dockerfile.base"
    exit 1
fi
echo ""

# Create data directories
DATA_DIR="/data/projects"
echo "Creating data directories..."
mkdir -p $DATA_DIR
chmod 755 $DATA_DIR
echo "✓ Data directory created at $DATA_DIR"
echo ""

# Verify the setup
echo "═══════════════════════════════════════════════════════════════════"
echo "                    Setup Complete!"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "Docker Network: $NETWORK_NAME"
echo "Base Image: $BASE_IMAGE"
echo "Data Directory: $DATA_DIR"
echo ""
echo "You can now start Prestige Build Pro with: npm start"
echo ""

# Connect the main container to the network if running in Docker
if [ -f /.dockerenv ]; then
    CONTAINER_ID=$(cat /proc/self/cgroup | grep docker | head -n 1 | cut -d/ -f3 | cut -c1-12)
    if [ -n "$CONTAINER_ID" ]; then
        echo "Connecting main container to '$NETWORK_NAME' network..."
        docker network connect $NETWORK_NAME $CONTAINER_ID 2>/dev/null || true
        echo "✓ Main container connected to network"
    fi
fi
