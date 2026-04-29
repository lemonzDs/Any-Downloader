// Image proxy — adds Referer header so AnyFlip CDN serves images.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const u = new URL(req.url);
    const target = u.searchParams.get("url");
    if (!target || !/^https:\/\/online\.anyflip\.com\//.test(target)) {
      return new Response("Bad url", { status: 400, headers: corsHeaders });
    }
    // Derive book base: https://online.anyflip.com/<user>/<book>/
    const m = target.match(/^(https:\/\/online\.anyflip\.com\/[^/]+\/[^/]+)\//);
    const bookBase = m ? `${m[1]}/` : target.replace(/[^/]+$/, "");

    async function tryFetch(referer: string) {
      return await fetch(target, {
        headers: {
          "User-Agent": UA,
          Referer: referer,
          Accept: "image/webp,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
besides          "Sec-Fetch-Dest": "image",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "same-origin",
        },
      });
    }

    // Try a few referer variants — different books require different ones
    const referers = [
      `${bookBase}mobile/index.html`,
      `${bookBase}index.html`,
      bookBase,
      "https://online.anyflip.com/",
    ];
    let r: Response | null = null;
    for (const ref of referers) {
      r = await tryFetch(ref);
      if (r.ok) break;
      // consume body to free resources
      try { await r.arrayBuffer(); } catch { /* ignore */ }
    }
    if (!r || !r.ok) return new Response(`Upstream ${r?.status ?? 502}`, { status: r?.status ?? 502, headers: corsHeaders });
    return new Response(r.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": r.headers.get("content-type") || "image/webp",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e) {
    return new Response(String(e), { status: 500, headers: corsHeaders });
  }
});
