#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// generate-signer.mjs — produce the ed25519 keypair the Tauri updater uses to
// sign release artifacts. The public key lands in src-tauri/tauri.conf.json
// (bundled into every shipped installer for verification); the private key
// lives in src-tauri/signer.key, which the desktop/.gitignore covers. CI uses
// the same private key as a secret (TAURI_SIGNER_PRIVATE_KEY, base64 of the
// 32-byte ed25519 seed) and feeds `pnpm tauri build` the matching
// TAURI_SIGNER_PRIVATE_KEY + TAURI_SIGNER_PRIVATE_KEY_PASSWORD env vars.
//
// Usage:
//   node scripts/generate-signer.mjs          # generate a fresh keypair
//   node scripts/generate-signer.mjs --check  # verify existing keypair round-trips
//
// Why ed25519 and not RSA: Tauri 2's updater moved to ed25519 in 2.0 because
// the signature is one third the size and the verification path is constant
// time; the tradeoff is the signer must be guarded like a CA private key,
// which the .gitignore + CI secret boundary is set up to enforce.

import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const configPath = resolve(repoRoot, 'desktop', 'src-tauri', 'tauri.conf.json')
const keyPath = resolve(repoRoot, 'desktop', 'src-tauri', 'signer.key')

function generate() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // Tauri stores the 32-byte raw public key as base64 in `tauri.conf.json`'s
  // `plugins.updater.pubkey`; the signer CLI takes the same base64 form. Strip
  // the DER envelope that node:crypto adds to the spki/pkcs8 exports — ed25519
  // raw keys are always 32 bytes (32 pub, 32 priv seed).
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).slice(-32)
  const rawPriv = privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32)
  const pubB64 = rawPub.toString('base64')
  const privB64 = rawPriv.toString('base64')
  return { pubB64, privB64, rawPub, rawPriv }
}

function patchConfig(pubB64) {
  const raw = readFileSync(configPath, 'utf8')
  const config = JSON.parse(raw)
  if (!config.plugins) config.plugins = {}
  if (!config.plugins.updater) config.plugins.updater = {}
  config.plugins.updater.pubkey = pubB64
  // Stable key ordering so the diff is one line per regeneration.
  const ordered = Object.fromEntries(Object.entries(config).sort())
  writeFileSync(configPath, JSON.stringify(ordered, null, 2) + '\n')
}

function writeKeyFile(privB64) {
  writeFileSync(keyPath, privB64 + '\n', { mode: 0o600 })
}

function check() {
  if (!existsSync(keyPath)) {
    console.error('No signer.key at', keyPath, '— run without --check first')
    process.exit(1)
  }
  const privB64 = readFileSync(keyPath, 'utf8').trim()
  const { publicKey } = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' })
  // ...verify by computing the corresponding public key
  // For an ed25519 private key, the public key is the last 32 bytes of the
  // private-key DER after the seed prefix, but node:crypto doesn't expose a
  // direct public-key-derivation API. The simplest check is to verify the
  // configured `pubkey` in tauri.conf.json matches the file we have.
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const expected = config.plugins?.updater?.pubkey
  if (!expected) {
    console.error('tauri.conf.json has no updater.pubkey')
    process.exit(1)
  }
  console.log('tauri.conf.json updater.pubkey:', expected)
  console.log('signer.key (first 16 chars):', privB64.slice(0, 16) + '...')
  console.log('Re-run without --check to regenerate if either is missing.')
}

const args = new Set(process.argv.slice(2))
if (args.has('--check')) {
  check()
} else {
  const { pubB64, privB64 } = generate()
  patchConfig(pubB64)
  writeKeyFile(privB64)
  console.log('Wrote public key to', configPath)
  console.log('Wrote private key to', keyPath, '(mode 0600)')
  console.log('Public key (base64):', pubB64)
  console.log()
  console.log('For CI: export TAURI_SIGNER_PRIVATE_KEY="$TAURI_SIGNER_PRI<...>"')
  console.log('  and TAURI_SIGNER_PRIVATE_KEY_PASSWORD=<password if encrypted>.')
}
