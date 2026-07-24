import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function* walkDir(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkDir(full);
    } else if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) {
      yield full;
    }
  }
}

const srcDir = resolve(__dirname, '..', 'src');
const files = [...walkDir(srcDir)];

console.log(`Found ${files.length} test files`);

let modifiedCount = 0;

for (const file of files) {
  let content = readFileSync(file, 'utf8');
  let modified = false;

  // Remove single-line imports from 'vitest'
  // e.g., import { describe, it, expect } from 'vitest';
  // e.g., import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
  const singleLineImportRegex = /^import\s*\{[^}]*\}\s*from\s*['"]vitest['"]\s*;?\s*$/gm;
  if (singleLineImportRegex.test(content)) {
    content = content.replace(singleLineImportRegex, '');
    modified = true;
  }

  // Remove multi-line imports from 'vitest'
  // e.g.:
  // import {
  //   describe,
  //   it,
  //   expect,
  // } from 'vitest';
  const multiLineImportRegex = /^import\s*\{[\s\S]*?\}\s*from\s*['"]vitest['"]\s*;?\s*$/gm;
  if (multiLineImportRegex.test(content)) {
    content = content.replace(multiLineImportRegex, '');
    modified = true;
  }

  // Clean up double blank lines
  content = content.replace(/\n{3,}/g, '\n\n');
  // If file starts with a blank line, remove it
  content = content.replace(/^\n+/, '');

  if (modified) {
    writeFileSync(file, content, 'utf8');
    modifiedCount++;
    console.log(`  Fixed: ${file}`);
  }
}

console.log(`\nModified ${modifiedCount} files`);
