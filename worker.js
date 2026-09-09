// Cloudflare Worker for cntdashboard.
//
// Serves the static dashboard (index.html) for normal requests, and proxies live Meta Marketing API
// requests through /api/insights so the "ดึงข้อมูลสดตอนนี้" button in the dashboard can pull real,
// current numbers without ever exposing a Meta access token in the browser.
//
// SETUP REQUIRED before the live-fetch button will work:
//   1. In Meta Business Settings, create a System User (or use an existing one) with admin/analyst
//      access to the ad accounts this dashboard reads (783833721188530, 1003863749343307,
//      1822065945093567), and generate a token for it with the "ads_read" permission. System User
//      tokens can be set to never expire, unlike a normal user access token (~60 days).
//   2. In the Cloudflare dashboard: Workers & Pages -> cntdashboard -> Settings -> Variables and
//      Secrets -> Add variable -> name it META_ACCESS_TOKEN, paste the token, toggle "Encrypt", save.
//      Do this directly in the Cloudflare dashboard UI (or via `wrangler secret put
//      META_ACCESS_TOKEN`) — never commit the token into this repo, which is public.
//
// Until the secret is set, /api/insights returns a clear error instead of failing silently.

const GRAPH_VERSION = 'v21.0';
const MESSAGING_ACTION_TYPE = 'onsite_conversion.messaging_conversation_started_7d';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/insights') {
      return handleInsights(env, url);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleInsights(env, url) {
  if (!env.META_ACCESS_TOKEN) {
    return jsonError(
      'ยังไม่ได้ตั้งค่า META_ACCESS_TOKEN บน Cloudflare Worker นี้ — ไปที่ Workers & Pages > cntdashboard > Settings > Variables and Secrets แล้วเพิ่ม permanent token จาก Meta Business Settings ก่อน',
      500
    );
  }

  const accountsParam = url.searchParams.get('accounts');
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  if (!accountsParam || !since || !until) {
    return jsonError('ขาดพารามิเตอร์ accounts/since/until', 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return jsonError('รูปแบบวันที่ต้องเป็น YYYY-MM-DD', 400);
  }

  const accounts = accountsParam.split(',').map((s) => s.trim()).filter(Boolean);
  const timeRange = JSON.stringify({ since, until });
  const fields = 'campaign_name,adset_name,ad_name,spend,reach,actions';

  try {
    const allRows = [];
    for (const accountId of accounts) {
      let nextUrl =
        `https://graph.facebook.com/${GRAPH_VERSION}/act_${accountId}/insights` +
        `?level=ad&fields=${encodeURIComponent(fields)}` +
        `&time_range=${encodeURIComponent(timeRange)}` +
        `&limit=500&access_token=${encodeURIComponent(env.META_ACCESS_TOKEN)}`;

      let pageCount = 0;
      while (nextUrl && pageCount < 20) {
        const res = await fetch(nextUrl);
        const body = await res.json();
        if (body.error) {
          return jsonError(`Meta API error (บัญชี ${accountId}): ${body.error.message || JSON.stringify(body.error)}`, 502);
        }
        for (const row of body.data || []) {
          const spend = parseFloat(row.spend || '0') || 0;
          const reach = parseInt(row.reach || '0', 10) || 0;
          let inbox = 0;
          if (Array.isArray(row.actions)) {
            const m = row.actions.find((a) => a.action_type === MESSAGING_ACTION_TYPE);
            if (m) inbox = parseInt(m.value || '0', 10) || 0;
          }
          allRows.push({
            campaign: row.campaign_name || '',
            adset: row.adset_name || '',
            ad: row.ad_name || '',
            spend,
            reach,
            inbox,
          });
        }
        nextUrl = body.paging && body.paging.next ? body.paging.next : null;
        pageCount++;
      }
    }
    return new Response(JSON.stringify(allRows), { status: 200, headers: JSON_HEADERS });
  } catch (e) {
    return jsonError('Worker exception: ' + (e && e.message ? e.message : String(e)), 500);
  }
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}
