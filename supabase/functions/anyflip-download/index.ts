// AnyFlip metadata fetcher — returns image URLs only.
// Client side handles WebP→canvas→PDF conversion (no CPU limits).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Accepts any of:
//   anyflip.com/abcd/efgh        anyflip.com/abcd/efgh/
//   https://anyflip.com/abcd/efgh/basic/    .../mobile/    .../index.html
//   https://online.anyflip.com/abcd/efgh/123.html
//   https://www.anyflip.com/abcd/efgh/?fr=sNTIxMzM...
//   https://online.anyflip.com/abcd/efgh/files/large/xyz.webp (image url)
function parseAnyflipUrl(input: string): { baseUrl: string; userId: string; bookId: string } {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new Error("URL AnyFlip tidak sah. Contoh: https://anyflip.com/abcd/efgh/");
  }
  if (!/(^|\.)anyflip\.com$/i.test(parsed.hostname)) {
    throw new Error(`Hos bukan AnyFlip: ${parsed.hostname}`);
  }
  // Split path, drop empty segments and known suffixes/files
  const parts = parsed.pathname.split("/").filter(Boolean).filter((p) => {
    if (/^(mobile|basic|index)(\.html?)?$/i.test(p)) return false;
    if (/\.(html?|js|css|webp|jpe?g|png|gif)$/i.test(p)) return false;
    if (/^\d+$/.test(p)) return false; // page number segment
    if (/^files$/i.test(p) || /^(large|mobile|thumbnail)$/i.test(p)) return false;
    return true;
  });
  if (parts.length < 2) {
    throw new Error("URL AnyFlip tidak sah — jangkakan format /<user>/<book>/");
  }
  const [userId, bookId] = parts;
  return { baseUrl: `https://online.anyflip.com/${userId}/${bookId}`, userId, bookId };
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
