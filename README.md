# Chanuntorn advertising dashboard

Production: https://cntdashboard.chanuntorn-dashboard.workers.dev/

Cloudflare deploys the main branch using wrangler.jsonc.
Build command: node build-worker.mjs. Deploy command: npx wrangler deploy.
The build composes generated-worker.js from the unchanged existing worker.js and
the report module; generated output must never be committed.
The existing Worker token source is preserved per the owner's instruction.
META_ACCESS_TOKEN can optionally override it as a Worker secret.

The deployed index.html contains the generated JavaScript and CSS inline,
preserving the original single-file hosting setup.

Meta reports use /api/report, with daily ad-level insights and creative images.
Google Ads and TikTok retain the imported historical Mono data through 2026-10-12.
Manual counts are browser-local, matching the previous system. Legacy daily count
keys and chat statuses are read without deletion; new entries use
cntdashboard.results.v2. The legacy page is retained at /legacy.html.

Fixed columns: Qulify, Non-Qulify, Click Line. Click a number to edit dated totals.
Ad Group and Ad Creative records remain independent; in All Platforms mode manual
entries are attributed to Meta (shown in the editor). Choose another platform to
record counts for it. Matching names are combined within the selected filters.

Validation: production build, browser interaction/mobile tests, legacy storage
migration, Google/TikTok filters, and live Meta reads for both Mono and Mews.
