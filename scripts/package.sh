#!/bin/sh
# Builds dist/opfs-inspector-<version>.zip with only the files the browser needs.
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
mkdir -p dist
rm -f "dist/opfs-inspector-$version.zip"
zip -q -r "dist/opfs-inspector-$version.zip" manifest.json devtools.html devtools.js panel.html panel.css build src icons LICENSE
echo "dist/opfs-inspector-$version.zip"
