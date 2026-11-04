#!/usr/bin/env bash
# Copies the real program interface (IDL) produced by `anchor build` into the app,
# so the app always uses your actual program id.
set -e
cd "$(dirname "$0")/.."
SRC=../target/idl/escrow.json
if [ ! -f "$SRC" ]; then
  echo "Could not find $SRC. Run 'anchor build' in the repo root first."
  exit 1
fi
cp "$SRC" src/idl/escrow.json
echo "Copied IDL. Program id: $(grep -o '"address": *"[^"]*"' src/idl/escrow.json | head -1)"
