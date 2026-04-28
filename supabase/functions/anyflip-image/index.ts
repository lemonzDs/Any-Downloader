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
    const referer = target.replace(/\/files\/.*$/, "/");
    const r = await fetch(target, { headers: { "User-Agent": UA, Referer: referer } });
    if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status, headers: corsHeaders });
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
