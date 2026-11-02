// Turn the single-file Vite build (dist/index.html, a full document) into the
// fragment the claude.ai Artifact publisher expects (title + style + markup + script,
// no doctype/html/head/body: the publisher wraps the file in its own skeleton).
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

function all(re) {
  const out = [];
  for (const m of src.matchAll(re)) out.push(m[0]);
  return out;
}

const title = (src.match(/<title>[\s\S]*?<\/title>/) ?? ['<title>BrightByte</title>'])[0];
const description = (src.match(/<meta name="description"[^>]*>/) ?? [''])[0];
const styles = all(/<style[^>]*>[\s\S]*?<\/style>/g);
const scripts = all(/<script[^>]*>[\s\S]*?<\/script>/g).map((s) => s.replace(/<script[^>]*>/, '<script type="module">'));
const body = (src.match(/<body[^>]*>([\s\S]*)<\/body>/) ?? [null, '<div id="app"></div>'])[1]
  .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
  .trim();

const out = [title, description, ...styles, body, ...scripts].filter(Boolean).join('\n');
writeFileSync(new URL('../dist/artifact.html', import.meta.url), out);
console.log(`dist/artifact.html: ${(out.length / 1024).toFixed(1)} kB, ${styles.length} style block(s), ${scripts.length} script block(s)`);
