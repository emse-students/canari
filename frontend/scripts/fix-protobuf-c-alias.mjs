/**
 * pbjs 8 static-module (es6) emits `new C()` in decode/fromObject without defining `C`.
 * Hoist a per-message alias before each IIFE return so runtime decode works in strict ESM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, 'src/lib/proto/canari.js');

let source = fs.readFileSync(target, 'utf8');
source = source.replace(
  /^(\s+)return ([A-Za-z][A-Za-z0-9_]*);\n(\s+\}\)\(\);)/gm,
  (match, indent, name, closing) => {
    if (name === 'values') return match;
    return `${indent}var C = ${name};\n${indent}return ${name};\n${closing}`;
  }
);

fs.writeFileSync(target, source);
console.log('[proto] injected C aliases into', path.relative(root, target));
