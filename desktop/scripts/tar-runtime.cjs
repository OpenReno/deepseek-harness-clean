#!/usr/bin/env node
// Pack dsh-runtime into a single .tar.gz using Node's fs to walk the
// source and an explicit filter (Windows bsdtar's --exclude syntax has
// gaps, and Windows native tar gives up on too many small files).
// Excludes everything not needed at runtime — .map / .d.ts / docs /
// tests / fixtures — bringing the file count from 100k+ down to ~5k.

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const deployDir = path.resolve(__dirname, '..', '.deploy', 'cli')
const outFile = path.resolve(__dirname, '..', 'dsh-runtime.tar.gz')

const SKIP_PATTERNS = [
  /\.(map|d\.ts|md|markdown)$/i,
  /\/(test|tests|__tests__|fixture|fixtures|example|examples|doc|docs)\//i,
  /\/(CHANGELOG|LICENSE|LICENSE\.md|LICENSE\.txt|README|README\.md|\.npmignore|\.eslintrc.*|\.prettierrc.*|tsconfig.*)$/i,
  /\/dist-types\//i,
  /\/dist\/esnext\//i,
  /\/build\/esnext\//i,
  /\/build\/src\//i,
  /\/esm\//i,  // keep dist/esm, drop other esm trees
  /\/node_modules\/.bin\//i,
]

function shouldSkip(relPath) {
  // Normalize to forward slashes so the regexes match Windows-style rel paths.
  return SKIP_PATTERNS.some(p => p.test(relPath.split(path.sep).join('/')))
}

function walkSync(dir, base = dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    console.warn('skip', dir, err.message)
    return out
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    const rel = path.relative(base, abs)
    if (shouldSkip(rel)) continue
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      walkSync(abs, base, out)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

const include = ['lib', 'node_modules', 'config', 'package.json']
const files = []
for (const dir of include) {
  const abs = path.join(deployDir, dir)
  if (!fs.existsSync(abs)) continue
  walkSync(abs, deployDir, files)
}

console.log(`packing ${files.length} files...`)
const start = Date.now()

// Write file list to a manifest, pipe to bsdtar via -T
const manifestPath = path.join(__dirname, '.tar-manifest.txt')
fs.writeFileSync(manifestPath, files.join('\n'))

const proc = spawn('C:/Windows/System32/tar.exe', [
  '-czf', outFile,
  '-C', deployDir,
  '-T', manifestPath,
], { stdio: 'inherit' })

proc.on('exit', (code) => {
  fs.unlinkSync(manifestPath)
  if (code === 0) {
    const stat = fs.statSync(outFile)
    console.log(`done in ${((Date.now() - start) / 1000).toFixed(1)}s → ${(stat.size / 1024 / 1024).toFixed(1)} MB`)
  } else {
    console.error(`tar exit ${code}`)
  }
  process.exit(code ?? 1)
})
