import { readFileSync, writeFileSync } from 'node:fs';
// Compose the report route with the existing Worker only inside the build workspace.
// The original worker.js is unchanged in Git; generated output is never committed.
const original = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const marker = "if (url.pathname === '/api/insights')";
if (!original.includes(marker)) throw new Error('Original Worker route not found');
const source = "import { cachedReport } from './report-cache.js';\nimport { resultStore } from './manual-results.js';\nimport { googleReport } from './google-report.js';\n" + original.replace(marker,
  "if (url.pathname === '/api/google-report') return googleReport(request, env);\n    if (url.pathname === '/api/manual-results' || url.pathname.startsWith('/api/manual-results/')) { return resultStore(request, env.RESULTS_DB, 'public-link'); }\n    if (url.pathname === '/api/insights' && (url.searchParams.get('accounts') || '').split(',').some(id => ['1003863749343307','1822065945093567'].includes(id.trim().replace(/^act_/,'')))) return Response.json({error:'หยุดดึงข้อมูล Mews ชั่วคราว'}, {status:503});\n    if (url.pathname === '/api/report') return cachedReport(request, env, env.META_ACCESS_TOKEN || HARDCODED_META_ACCESS_TOKEN);\n    " + marker);
writeFileSync(new URL('./generated-worker.js', import.meta.url), source);
