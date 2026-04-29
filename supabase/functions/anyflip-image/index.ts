// AnyFlip image proxy — adds Referer header + auto-tries /files/large/ fallbacks.
// Returns detailed diagnostics in response headers (X-Anyflip-*) so the UI can
// surface why a page failed without changing the binary body.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers":
    "X-Anyflip-Final-Url, X-Anyflip-Referer, X-Anyflip-Attempts, X-Anyflip-Upstream-Status, X-Anyflip-Upstream-Server, X-Anyflip-Upstream-CfRay",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

interface Attempt {
  url: string;
  status: number;
  contentType: string | null;
  server: string | null;
  cfRay: string | null;
  ms: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const u = new URL(req.url);
  const target = u.searchParams.get("url");
  let parsed: URL | null = null;
  try { if (target) parsed = new URL(target); } catch { /* ignore */ }
  if (!parsed || !/(^|\.)anyflip\.com$/i.test(parsed.hostname)) {
    return new Response(JSON.stringify({ error: "Bad url — must be an anyflip.com host" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // Normalise host to online.anyflip.com (CDN host)
  parsed.hostname = "online.anyflip.com";
  const normalisedTarget = parsed.toString();

  // Derive book base from path: /<user>/<book>/...
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) {
    return new Response(JSON.stringify({ error: "URL imej tidak mengandungi /<user>/<book>/" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const bookBase = `https://online.anyflip.com/${pathParts[0]}/${pathParts[1]}/`;
  const referer = `${bookBase}mobile/index.html`;
  const filename = pathParts[pathParts.length - 1];

  // Candidates — config.js sometimes lists bare filenames that actually live in /files/large/
  const candidates = Array.from(new Set([
    normalisedTarget,
    `${bookBase}files/large/${filename}`,
    `${bookBase}files/mobile/${filename}`,
    `${bookBase}${filename}`,
  ]));

  const attempts: Attempt[] = [];
  let success: { url: string; res: Response } | null = null;

  for (const url of candidates) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Referer: referer,
          Accept: "image/webp,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch (e) {
      attempts.push({
        url, status: 0, contentType: null, server: null, cfRay: null,
        ms: Date.now() - t0,
      });
      console.log(`[anyflip-image] FETCH_ERR ${url} → ${(e as Error).message}`);
      continue;
    }
    const a: Attempt = {
      url,
      status: res.status,
      contentType: res.headers.get("content-type"),
      server: res.headers.get("server"),
      cfRay: res.headers.get("cf-ray") || res.headers.get("x-amz-cf-id"),
      ms: Date.now() - t0,
    };
    attempts.push(a);
    console.log(`[anyflip-image] ${res.status} ${url} (${a.ms}ms) referer=${referer}`);

    if (res.ok && (a.contentType?.startsWith("image/") ?? true)) {
      success = { url, res };
      break;
    }
    try { await res.arrayBuffer(); } catch { /* drain */ }
  }

  const diagHeaders: Record<string, string> = {
    "X-Anyflip-Referer": referer,
    "X-Anyflip-Attempts": JSON.stringify(attempts),
  };

  if (!success) {
    const last = attempts[attempts.length - 1];
    return new Response(
      JSON.stringify({
        error: "All upstream candidates failed",
        referer,
        attempts,
      }),
      {
        status: last?.status && last.status >= 400 ? last.status : 502,
        headers: { ...corsHeaders, ...diagHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const { url: finalUrl, res } = success;
  return new Response(res.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      ...diagHeaders,
      "X-Anyflip-Final-Url": finalUrl,
      "X-Anyflip-Upstream-Status": String(res.status),
      "X-Anyflip-Upstream-Server": res.headers.get("server") ?? "",
      "X-Anyflip-Upstream-CfRay": res.headers.get("cf-ray") ?? "",
      "Content-Type": res.headers.get("content-type") || "image/webp",
      "Cache-Control": "public, max-age=3600",
    },
  });
});
