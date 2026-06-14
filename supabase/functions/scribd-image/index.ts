// Scribd image proxy — adds Referer header. Whitelists *.scribdassets.com hosts.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers":
    "X-Scribd-Final-Url, X-Scribd-Referer, X-Scribd-Upstream-Status, X-Scribd-Attempts",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const REFERER = "https://www.scribd.com/";

interface Attempt { url: string; status: number; ms: number; contentType: string | null }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const u = new URL(req.url);
  const target = u.searchParams.get("url");
  let parsed: URL | null = null;
  try { if (target) parsed = new URL(target); } catch { /* ignore */ }
  if (!parsed || !/(^|\.)scribdassets\.com$/i.test(parsed.hostname)) {
    return new Response(JSON.stringify({ error: "Bad url — must be a scribdassets.com host" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const attempts: Attempt[] = [];
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": UA,
        Referer: REFERER,
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (e) {
    attempts.push({ url: parsed.toString(), status: 0, ms: Date.now() - t0, contentType: null });
    return new Response(JSON.stringify({ error: (e as Error).message, attempts }), {
      status: 502,
      headers: {
        ...corsHeaders,
        "X-Scribd-Referer": REFERER,
        "X-Scribd-Attempts": JSON.stringify(attempts),
        "Content-Type": "application/json",
      },
    });
  }
  const a: Attempt = {
    url: parsed.toString(),
    status: res.status,
    ms: Date.now() - t0,
    contentType: res.headers.get("content-type"),
  };
  attempts.push(a);
  console.log(`[scribd-image] ${res.status} ${parsed.toString()} (${a.ms}ms)`);

  if (res.ok && (a.contentType?.startsWith("image/") ?? true)) {
    return new Response(res.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "X-Scribd-Final-Url": parsed.toString(),
        "X-Scribd-Referer": REFERER,
        "X-Scribd-Upstream-Status": String(res.status),
        "X-Scribd-Attempts": JSON.stringify(attempts),
        "Content-Type": res.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  try { await res.arrayBuffer(); } catch { /* drain */ }
  return new Response(JSON.stringify({ error: `Upstream ${res.status}`, attempts }), {
    status: res.status >= 400 ? res.status : 502,
    headers: {
      ...corsHeaders,
      "X-Scribd-Referer": REFERER,
      "X-Scribd-Attempts": JSON.stringify(attempts),
      "Content-Type": "application/json",
    },
  });
});
