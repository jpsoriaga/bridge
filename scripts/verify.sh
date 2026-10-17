#!/usr/bin/env bash
set -euo pipefail

echo "=== Verifying Bridge Monorepo ==="

echo "1. Checking TypeScript types across all packages..."
pnpm run typecheck

echo "2. Building shared package..."
pnpm run build:shared

echo "3. Building Chrome extension..."
pnpm run build:extension

echo "4. Building Desktop application..."
pnpm run build:desktop

echo "=== All checks passed! ==="
