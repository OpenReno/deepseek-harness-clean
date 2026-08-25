#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// dev.mjs — one-shot wrapper for `pnpm tauri dev` that ensures the sidecar
// bundle is current. Tauri's beforeDevCommand in tauri.conf.json also points
// here, so the bundle is refreshed on every `tauri dev` and `tauri build`.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(__dirname, '..')

const child = spawn(
  'pnpm',
  ['exec', 'tauri', 'dev'],
  { stdio: 'inherit', cwd: desktopDir, shell: false },
)
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error(err)
  process.exit(1)
})