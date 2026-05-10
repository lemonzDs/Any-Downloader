// AnyFlip metadata fetcher — returns image URLs only.
// Resolves short links (bookcase, share URLs) via redirect chain,
// then normalizes to canonical online.anyflip.com/<user>/<book>/ form.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function tryExtractUserBook(parsed: URL): { userId: string; bookId: string } | null {
  if (!/(^|\.)anyflip\.com$/i.test(parsed.hostname)) return null;
  // Strip query/hash entirely — canonical book URL never needs them
  const cleanPath = parsed.pathname.replace(/\/+/g, "/");
  const parts = cleanPath.split("/").filter(Boolean).filter((p) => {
    if (/^(mobile|basic|index|flash|html5|pubs?|p|page|pages|view|read)(\.html?)?$/i.test(p)) return false;
    if (/\.(html?|js|css|webp|jpe?g|png|gif|json)$/i.test(p)) return false;
    if (/^\d+$/.test(p)) return false;
    if (/^files$/i.test(p) || /^(large|mobile|thumbnail|small|medium)$/i.test(p)) return false;
    if (/^(javascript|css|images?|assets)$/i.test(p)) return false;
    return true;
  });
  if (parts.length < 2) return null;
  // Skip known non-book prefixes
  if (/^(bookcase|home|search|profile)$/i.test(parts[0])) return null;
  return { userId: parts[0], bookId: parts[1] };
}

// Follows redirects (HEAD/GET) for AnyFlip short links like
// https://anyflip.com/bookcase/xxxx → https://anyflip.com/<user>/<book>/
async function resolveRedirects(rawUrl: string): Promise<{ finalUrl: string; chain: string[] }> {
  const chain: string[] = [rawUrl];
  let current = rawUrl;
  for (let i = 0; i < 6; i++) {
    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      });
    } catch {
      break;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (!loc) break;
      const next = new URL(loc, current).toString();
      try {
        const nextHost = new URL(next).hostname;
        if (!/(^|\.)anyflip\.com$/i.test(nextHost)) {
          chain.push(`${next} (blocked: host ${nextHost} not allowed)`);
          break;
        }
      } catch { break; }
      chain.push(next);
      current = next;
      continue;
    }
    // 200 — try to spot a meta-refresh or canonical URL inside HTML
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        const html = await res.text();
        const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i);
        const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
        const ogUrl = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
        const next = meta?.[1] || canonical?.[1] || ogUrl?.[1];
        if (next) {
          const abs = new URL(next, current).toString();
          if (abs !== current) {
            chain.push(abs);
            current = abs;
            continue;
          }
        }
      } else {
        try { await res.body?.cancel(); } catch { /* ignore */ }
      }
    } else {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    break;
  }
  return { finalUrl: current, chain };
}

async function parseAnyflipUrl(input: string): Promise<{
  baseUrl: string;
  userId: string;
  bookId: string;
  canonicalUrl: string;
  redirectChain: string[];
}> {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new Error("URL AnyFlip tidak sah. Contoh: https://anyflip.com/abcd/efgh/");
  }
  if (!/(^|\.)anyflip\.com$/i.test(parsed.hostname)) {
    throw new Error(`Hos bukan AnyFlip: ${parsed.hostname}`);
  }

  let chain: string[] = [raw];
  let extracted = tryExtractUserBook(parsed);

  // If direct extraction failed (e.g. bookcase/share link), follow redirects
  if (!extracted) {
    const resolved = await resolveRedirects(raw);
    chain = resolved.chain;
    try {
      const finalParsed = new URL(resolved.finalUrl);
      extracted = tryExtractUserBook(finalParsed);
    } catch { /* ignore */ }
  }

  if (!extracted) {
    throw new Error(
      `Tidak dapat mengekstrak <user>/<book> dari URL. Cuba tampal URL terus dari pemandang buku. Chain: ${chain.join(" → ")}`,
    );
  }

  const { userId, bookId } = extracted;
  const baseUrl = `https://online.anyflip.com/${userId}/${bookId}`;
  const canonicalUrl = `${baseUrl}/`;
  return { baseUrl, userId, bookId, canonicalUrl, redirectChain: chain };
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
    const body = await req.json();
    const { url, resolveOnly } = body as { url?: string; resolveOnly?: boolean };
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Sila berikan URL AnyFlip" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { baseUrl, userId, bookId, canonicalUrl, redirectChain } = await parseAnyflipUrl(url);

    if (resolveOnly) {
      return new Response(
        JSON.stringify({ canonicalUrl, baseUrl, userId, bookId, redirectChain }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { pages, title } = await fetchConfig(baseUrl);
    if (pages.length === 0) {
      return new Response(JSON.stringify({ error: "Tiada halaman dijumpai" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ title, pages, baseUrl, canonicalUrl, userId, bookId, redirectChain }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
