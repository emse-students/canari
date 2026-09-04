#!/usr/bin/env node
/**
 * Reads the checkpoint cost per PLATFORM out of a run's captures.
 *
 * `6bfd805d` removed a duplicate `mls.bin` write on native - 3.7 s per checkpoint split-timed into
 * 1.7 s of real save and 2.0 s of duplicate marshalled through IPC as a `number[]`. A green build
 * proves none of that, so the number has to be read off a phone that is actually running.
 *
 * The app already logs its own duration (`[MLS] Encrypted state checkpoint persisted. (N ms)`), so
 * nothing needs instrumenting. What DOES need care is attribution: a capture holds several consoles,
 * web checkpoints land in tens of milliseconds and native in hundreds, and averaging them together
 * produces a number belonging to no device. A stream is the phone's when its OWN lines say
 * `mode=tauri` - never because it sits next to one that does.
 *
 *   bun ckpt.mjs [logs/<run-dir>]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? latestRun();

function latestRun() {
  const base = new URL('./logs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const runs = readdirSync(base).filter((d) => /^\d{4}-/.test(d)).sort();
  if (!runs.length) throw new Error('no run directory under logs/');
  return join(base, runs[runs.length - 1]);
}

/**
 * The captures are a JSON object followed by the verdict line, so `JSON.parse` on the whole file
 * throws. Take the balanced leading object, respecting strings and escapes - a brace inside a logged
 * message would otherwise end the object early and lose every stream after it.
 */
function leadingJson(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(0, i + 1);
  }
  return null;
}

const rows = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.log'))) {
  const js = leadingJson(readFileSync(join(dir, f), 'utf8'));
  if (!js) continue;
  let parsed;
  try {
    parsed = JSON.parse(js);
  } catch {
    continue;
  }
  (function walk(node, path) {
    if (Array.isArray(node) && node.every((x) => typeof x === 'string')) {
      const tauri = node.some((l) => /mode=tauri/.test(l));
      for (const l of node) {
        const m = l.match(/checkpoint persisted\.? \((\d+) ms\)/);
        if (m) rows.push({ f, path, tauri, ms: Number(m[1]) });
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], path ? `${path}.${k}` : k);
    }
  })(parsed, '');
}

const stat = (a) => (a.length ? `n=${a.length}  min=${a[0]}  median=${a[a.length >> 1]}  max=${a[a.length - 1]}` : 'n=0');
const native = rows.filter((r) => r.tauri).map((r) => r.ms).sort((a, b) => a - b);
const web = rows.filter((r) => !r.tauri).map((r) => r.ms).sort((a, b) => a - b);

console.log(`run: ${dir}\n`);
console.log(`NATIVE (mode=tauri): ${stat(native)}`);
if (native.length) console.log(`  ${native.join(', ')} ms`);
console.log(`WEB                : ${stat(web)}`);
console.log(`\nstreams carrying a checkpoint line:`);
for (const s of [...new Set(rows.map((r) => `${r.f}  ${r.path}${r.tauri ? '  [TAURI]' : ''}`))]) console.log(`  ${s}`);
