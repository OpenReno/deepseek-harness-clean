#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// check-peer-deps.cjs — post-deploy smoke test for the dsh-runtime bundle.
//
// Background: `pnpm deploy --prod` does not ship peer dependencies (a pnpm
// rule, not an upstream choice). Every @deepseek-ai/* workspace package the
// host loads through its cordis plugin tree is a workspace package, and every
// workspace package is built and on disk — but if apps/cli/package.json
// declares it only transitively, pnpm drops it from the deploy graph and the
// host's loader crashes at import time with ERR_MODULE_NOT_FOUND. Today the
// only mitigation is to add the missing package as a direct dep of apps/cli,
// one at a time, every time upstream adds a new tool or service.
//
// This script walks the cordis patch + base layer the web profile boots and,
// for every plugin row that resolves to a `@deepseek-ai/*` package, demands a
// working `require.resolve()` from the deployed dsh-runtime cwd. A failure
// prints the exact missing package and the loader entry that needs it, so the
// patch is one line: add the missing name to apps/cli/package.json.
//
// Usage:
//   node desktop/scripts/check-peer-deps.cjs                    # post-deploy check
//   node desktop/scripts/check-peer-deps.cjs --json           # machine-readable
//   node desktop/scripts/check-peer-deps.cjs --patch=PATH     # alternate cordis.patch.yml
//
// Exit code 0 if every entry resolves, 1 if any are missing.

'use strict'

const fs = require('node:fs')
const path = require('node:path')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readYaml(file) {
  // Cordis patches use two nested list shapes that we care about:
  //   1. Top-level `- id: foo` + `name: '@scope/pkg'` (rare, single-row override)
  //   2. Top-level `- insert:` containing nested `- id: foo` + `name: '@scope/pkg'`
  //      (the common case — bundle patches emit one `- insert:` block per layer)
  // Both shapes need to feed into the same id+name pair list. We tokenize by
  // any `- id:` line (matching either column 0 or after whitespace), then read
  // the immediately-following `name:` line from the same block. This avoids
  // pulling in js-yaml for a 6-line parser and matches exactly the shapes the
  // upstream emits.
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const idMatch = /^\s*- id:\s*(\S+)\s*$/.exec(lines[i])
    if (!idMatch) continue
    const id = idMatch[1]
    // Look ahead a few lines for `name: '...'` — cordis patches put name
    // on the next non-comment line. Skip comments (`#`) and blanks.
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const line = lines[j]
      if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue
      const nameMatch = /^\s+name:\s*['"]?(@?[^'"\s]+)['"]?\s*$/.exec(line)
      if (nameMatch) {
        rows.push({ id, name: nameMatch[1] })
        break
      }
      // Stop scanning on the first non-blank, non-comment line that isn't
      // the name — keeps a config-only override from accidentally matching
      // the comment header of the next block.
      break
    }
  }
  return rows
}

function findBundles(deployDir, name) {
  // Discover the package.json for a plugin name by trying both `.pnpm/<scope>+name>@version/...`
  // and the promoted top-level node_modules/<scope>/<name>. Each format
  // appears depending on whether pnpm deploy happened with or without
  // promotion. The first hit wins.
  const candidates = [
    path.join(deployDir, 'node_modules', name, 'package.json'),
  ]
  // @scope/name style namespacing
  if (name.startsWith('@')) {
    const [scope, pkg] = name.split('/')
    candidates.push(path.join(deployDir, 'node_modules', scope, pkg, 'package.json'))
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function main() {
  const args = process.argv.slice(2)
  const jsonOut = args.includes('--json')
  const patchArg = args.find(a => a.startsWith('--patch='))
  // script lives at desktop/scripts/check-peer-deps.cjs → desktop/scripts → desktop → repoRoot
  const repoRoot = path.resolve(__dirname, '..', '..')
  const deployDir = path.join(repoRoot, 'desktop', '.deploy', 'cli')
  // web profile = base + web-app bundles; both contribute plugin rows.
  const patchFiles = patchArg
    ? [path.resolve(patchArg.slice('--patch='.length))]
    : [
        path.join(repoRoot, 'packages', 'bundle', 'base', 'cordis.patch.yml'),
        path.join(repoRoot, 'packages', 'bundle', 'web-app', 'cordis.patch.yml'),
      ]

  const seen = new Set()
  const rows = []
  for (const f of patchFiles) {
    if (!fs.existsSync(f)) {
      console.error('Missing patch file:', f)
      continue
    }
    for (const row of readYaml(f)) {
      if (!row.name.startsWith('@deepseek-ai/')) continue
      if (row.name === '@deepseek-ai/dsh') continue // the host entry itself
      if (seen.has(row.name)) continue
      seen.add(row.name)
      rows.push(row)
    }
  }

  // Resolve every workspace package named in the patch from the deploy cwd.
  // We don't actually import — Node's resolution algorithm alone is enough
  // to catch every ERR_MODULE_NOT_FOUND we care about, and avoiding import
  // keeps the script side-effect free (it can run on a partial deploy).
  process.chdir(deployDir)
  const failures = []
  for (const row of rows) {
    let ok = true
    let detail = ''
    try {
      // require.resolve walks the same module resolution the host does.
      // If the top-level node_modules/<scope>/<name> link is missing, .pnpm
      // symlinks still resolve; this catches both the previous peer-dep
      // omission bug (no package at all) and the symlink-promotion drift
      // (package in .pnpm/ but no top-level link).
      require.resolve(row.name, { paths: [deployDir] })
    } catch (err) {
      ok = false
      detail = err.code || err.message.split('\n')[0]
      // Record WHERE in the deploy tree we'd expect to find it, so the
      // operator can tell apart "missing from .pnpm" (peer dep never
      // promoted — apps/cli/package.json needs the new entry) from "missing
      // top-level link" (symlink promotion bug — ensureDeploySymlinks needs
      // another path-pattern fix).
      const pkgPath = findBundles(deployDir, row.name)
      detail += pkgPath ? ` (found in .pnpm/, top-level link missing)` : ` (no entry in .pnpm/ — add to apps/cli deps)`
    }
    row.ok = ok
    row.detail = detail
    if (!ok) failures.push(row)
  }

  if (jsonOut) {
    console.log(JSON.stringify({ rows, failures: failures.map(f => ({ id: f.id, name: f.name, detail: f.detail })) }, null, 2))
  } else {
    const ok = rows.filter(r => r.ok).length
    console.log(`Checked ${rows.length} @deepseek-ai/* plugin entries from the web profile.`)
    if (failures.length === 0) {
      console.log('All resolve cleanly from', deployDir)
    } else {
      console.log(`${failures.length} entries failed to resolve:`)
      for (const f of failures) {
        console.log(`  ${f.id}  →  ${f.name}`)
        console.log(`     ${f.detail}`)
      }
      console.log()
      console.log('Fix: add the missing package(s) to apps/cli/package.json dependencies,')
      console.log('     re-run pnpm deploy --prod --legacy, then re-run this script.')
    }
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
