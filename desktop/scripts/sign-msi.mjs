#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// sign-msi.mjs — emit the ed25519 signature Tauri stores in latest.json's
// `platforms[target].signature` field. The signing key comes from the
// TAURI_SIGNER_PRIVATE_KEY env var (base64 of the raw 32-byte ed25519 seed,
// matching the format `generate-signer.mjs` writes). The updater on every
// installed client verifies the downloaded installer against the matching
// public key (configured in tauri.conf.json -> plugins.updater.pubkey).
//
// This script is run by release-desktop.yml's "Generate updater latest.json"
// step. It is NOT the same signing the tauri build runs internally — that
// one stamps the executable's PE header so the running binary knows its
// build provenance, while this script produces the value that goes on the
// wire inside latest.json.
//
// Usage:
//   TAURI_SIGNER_PRIVATE_KEY=<base64> node desktop/scripts/sign-msi.mjs path/to/installer.msi
//
// Output:
//   prints the signature as a hex string (Tauri's wire format for the
//   latest.json field) to stdout. Returns exit 1 on any failure so CI
//   halts the pipeline with a loud error.

import { createHash, sign as cryptoSign, createPrivateKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

const keyB64 = process.env.TAURI_SIGNER_PRIVATE_KEY
if (!keyB64) {
  console.error('sign-msi: TAURI_SIGNER_PRIVATE_KEY is not set')
  process.exit(1)
}
const target = process.argv[2]
if (!target) {
  console.error('sign-msi: usage: node sign-msi.mjs <path-to-installer>')
  process.exit(1)
}

let payload
try {
  payload = readFileSync(target)
} catch (err) {
  console.error(`sign-msi: failed to read ${target}:`, err.message)
  process.exit(1)
}

// Tauri 2 verifies the signature against the SHA-256 digest of the file
// (NOT the raw bytes). The signature in latest.json is the hex of
// ed25519(raw_digest_bytes) — wire shape: 128 hex chars (64 bytes).
const digest = createHash('sha256').update(payload).digest()
const privKey = createPrivateKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8' })
const signature = cryptoSign(null, digest, privKey)
process.stdout.write(signature.toString('hex'))
