// make-clean-bundle.js  — produce a minimal code bundle for review
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const OUT  = path.join(ROOT, 'deepresearch_bundle_min.txt');

// ---- DO NOT traverse these folders at all ----
const EXCLUDE_SEGMENTS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.cache', '.vercel', 'certs'
]);

// ---- Only include these roots/files (whitelist) ----
const ALLOW_PREFIXES = [
  'lib/',                // backend libs & bridges
  'schemas/',            // JSON schema
  'utils/',              // small helpers
  'web/app/',            // Next app pages
  'web/components/',     // shared components
  'web/public/worklets/' // audio worklets
];

const ALLOW_FILES = new Set([
  'index.js',
  'web-demo-live.js',
  'web-demo-bus.js',
  'web-demo.js',
  'ws-ping.js',
  'package.json',
  // web config files
  'web/package.json',
  'web/next.config.js',
  'web/postcss.config.js',
  'web/tailwind.config.js',
  'web/tsconfig.json',
  'web/.eslintrc.json',
  'web/next-env.d.ts'
]);

// ---- Allowed extensions ----
const OK_EXT = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.json','.css']);

// ---- Helpers ----
function isExcluded(relPath) {
  const parts = relPath.split(path.sep);
  return parts.some(p => EXCLUDE_SEGMENTS.has(p));
}
function isAllowed(relPath) {
  if (ALLOW_FILES.has(relPath.replace(/\\/g,'/'))) return true;
  const asPosix = relPath.replace(/\\/g,'/') + (relPath.endsWith(path.sep) ? '' : '');
  return ALLOW_PREFIXES.some(prefix => asPosix.startsWith(prefix));
}
function extOK(file) {
  return OK_EXT.has(path.extname(file).toLowerCase());
}
function* walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(ROOT, p);
    if (isExcluded(rel)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      // only descend into allowed trees or parents thereof
      const relPosix = rel.replace(/\\/g,'/') + '/';
      const mayContainAllowed =
        ALLOW_PREFIXES.some(pref => pref.startsWith(relPosix)) || // parent of an allowed prefix
        isAllowed(rel + '/');                                      // itself is allowed prefix
      if (mayContainAllowed) yield* walk(p);
    } else if (st.isFile()) {
      if (extOK(p) && (isAllowed(rel) || ALLOW_FILES.has(rel.replace(/\\/g,'/')))) {
        yield rel;
      }
    }
  }
}

function write(line='', append=true) {
  fs.writeFileSync(OUT, line + (line.endsWith('\n')?'':'\n'), { flag: append?'a':'w' });
}

// ---- Start output ----
write(`## Minimal debug bundle created ${new Date().toISOString()}`, false);
write(`\n## Included roots\n${['(root files)', ...ALLOW_PREFIXES].join('\n')}\n`);

// Shallow tree (depth 2) for visibility, without excluded dirs
write(`\n## Repo tree (depth 2, filtered)\n`);
const depth2 = [];
function walkDepth(dir, depth, max=2) {
  if (depth > max) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(ROOT, p);
    if (isExcluded(rel)) continue;
    const st = fs.statSync(p);
    const relPosix = rel.replace(/\\/g,'/');
    const show = (rel === '' ? '.' : relPosix);
    // Only show items that are on the allowed path(s)
    const visible = rel === '' ||
      ALLOW_FILES.has(relPosix) ||
      isAllowed(relPosix) ||
      ALLOW_PREFIXES.some(pref => pref.startsWith(relPosix + '/'));
    if (!visible) continue;

    depth2.push(show);
    if (st.isDirectory()) walkDepth(p, depth+1, max);
  }
}
walkDepth(ROOT, 0, 2);
write(depth2.sort().join('\n'));

write('\n');

// Dump files
const files = Array.from(walk(ROOT)).sort((a,b)=>a.localeCompare(b));
for (const rel of files) {
  write(`===== BEGIN ${rel} =====`);
  try {
    write(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch {
    write('<unable to read file as text>');
  }
  write(`===== END ${rel} =====\n`);
}
write('# EOF');

console.log(`Wrote ${OUT}`);
console.log(`Files included: ${files.length}`);
