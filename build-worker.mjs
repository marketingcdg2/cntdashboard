import { readFileSync, writeFileSync } from 'node:fs';
// Compose the report route with the existing Worker only inside the build workspace.
// The original worker.js is unchanged in Git; generated output is never committed.
const original = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const marker = "if (url.pathname === '/api/insights')";
if (!original.includes(marker)) throw new Error('Original Worker route not found');
const source = "import { report } from './report-worker.js';\n" + original.replace(marker,
  "if (url.pathname === '/api/report') return report(request, env.META_ACCESS_TOKEN || HARDCODED_META_ACCESS_TOKEN);\n    " + marker);
writeFileSync(new URL('./generated-worker.js', import.meta.url), source);
