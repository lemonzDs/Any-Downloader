// AnyFlip metadata fetcher — returns image URLs only.
// Client side handles WebP→canvas→PDF conversion (no CPU limits).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function parseAnyflipUrl(input: string): { baseUrl: string } {
  const cleaned = input.trim().replace(/[?#].*$/, "")
    .replace(/\/(mobile|basic|index)(\.html?)?\/?$/i, "").replace(/\/+$/, "");
  const m = cleaned.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/?#]+)/i);
  if (!m) throw new Error("URL AnyFlip tidak sah. Contoh: https://anyflip.com/abcd/efgh/");
  return { baseUrl: `https://online.anyflip.com/${m[1]}/${m[2]}` };
}

async function fetchConfig(baseUrl: string) {
  const candidates = [`${baseUrl}/mobile/javascript/config.js`, `${baseUrl}/javascript/config.js`];
  let text = "", lastErr = "";
  for (const u of candidates) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA, Referer: `${baseUrl}/` } });
      if (r.ok) { text = await r.text(); if (text.length > 200) break; } else lastErr = `${u} → ${r.status}`;
    } catch (e) { lastErr = (e as Error).message; }
  }
  if (!text) throw new Error(`Tidak dapat capai config buku. ${lastErr}`);

  const pageRegex = /"n"\s*:\s*\[\s*"([^"]+)"/g;
  const pages: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pageRegex.exec(text)) !== null) {
    const rel = m[1].replace(/\\\//g, "/").replace(/^\.\.\//, "");
    pages.push(`${baseUrl}/${rel}`);
  }
  let title = "anyflip-book";
  const tMatch = text.match(/"?title"?\s*:\s*"([^"]{1,200})"/i);
  if (tMatch) title = tMatch[1].replace(/[^\w\s.\-]/g, "_").trim().slice(0, 80) || title;
  return { pages, title };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Sila berikan URL AnyFlip" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { baseUrl } = parseAnyflipUrl(url);
    const { pages, title } = await fetchConfig(baseUrl);
    if (pages.length === 0) {
      return new Response(JSON.stringify({ error: "Tiada halaman dijumpai" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ title, pages, baseUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
