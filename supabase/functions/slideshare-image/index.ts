// SlideShare image proxy — adds Referer header so the CDN serves the image.
// Whitelists image.slidesharecdn.com / cdn.slidesharecdn.com hosts.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers":
    "X-Slideshare-Final-Url, X-Slideshare-Referer, X-Slideshare-Upstream-Status, X-Slideshare-Attempts",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const REFERER = "https://www.slideshare.net/";

interface Attempt { url: string; status: number; ms: number; contentType: string | null }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const u = new URL(req.url);
  const target = u.searchParams.get("url");
  let parsed: URL | null = null;
  try { if (target) parsed = new URL(target); } catch { /* ignore */ }
  if (!parsed || !/(^|\.)slidesharecdn\.com$/i.test(parsed.hostname)) {
    return new Response(JSON.stringify({ error: "Bad url — must be a slidesharecdn.com host" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Build resolution fallbacks: -N-2048.jpg → -N-1024.jpg → -N-638.jpg
  const candidates: string[] = [parsed.toString()];
  const m = parsed.pathname.match(/-(\d+)-(2048|1024|638)\.jpg$/);
  if (m) {
    const num = m[1];
    for (const res of ["2048", "1024", "638"]) {
      const alt = parsed.toString().replace(/-(\d+)-(2048|1024|638)\.jpg/, `-${num}-${res}.jpg`);
      if (!candidates.includes(alt)) candidates.push(alt);
    }
  }

  const attempts: Attempt[] = [];
  for (const url of candidates) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Referer: REFERER,
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch (e) {
      attempts.push({ url, status: 0, ms: Date.now() - t0, contentType: null });
      console.log(`[slideshare-image] FETCH_ERR ${url} → ${(e as Error).message}`);
      continue;
    }
    const a: Attempt = {
      url, status: res.status, ms: Date.now() - t0,
      contentType: res.headers.get("content-type"),
    };
    attempts.push(a);
    console.log(`[slideshare-image] ${res.status} ${url} (${a.ms}ms)`);
    if (res.ok && (a.contentType?.startsWith("image/") ?? true)) {
      return new Response(res.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "X-Slideshare-Final-Url": url,
          "X-Slideshare-Referer": REFERER,
          "X-Slideshare-Upstream-Status": String(res.status),
          "X-Slideshare-Attempts": JSON.stringify(attempts),
          "Content-Type": res.headers.get("content-type") || "image/jpeg",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }
    try { await res.arrayBuffer(); } catch { /* drain */ }
  }

  const last = attempts[attempts.length - 1];
  return new Response(JSON.stringify({ error: "All upstream candidates failed", attempts }), {
    status: last?.status && last.status >= 400 ? last.status : 502,
    headers: {
      ...corsHeaders,
      "X-Slideshare-Referer": REFERER,
      "X-Slideshare-Attempts": JSON.stringify(attempts),
      "Content-Type": "application/json",
    },
  });
});
