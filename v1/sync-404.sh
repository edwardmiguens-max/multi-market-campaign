#!/usr/bin/env bash
# Copies the canonical report viewer to the repo root as 404.html.
# GitHub Pages requires 404.html at root for pretty URLs like /your-report-slug
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/report.html" "${SCRIPT_DIR}/../404.html"
echo "Updated ../404.html from v1/report.html"
