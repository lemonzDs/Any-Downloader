// Scribd metadata fetcher — extracts page image URLs from a Scribd document/presentation.
// Strategy:
//  1) Normalise URL → extract docId from /document/{id}/... or /presentation/{id}/... or /embeds/{id}/...
//  2) Fetch the embed page (https://www.scribd.com/embeds/{id}/content?start_page=1&view_mode=scroll)
//     with a desktop UA + Referer. The embed page exposes per-page image URLs on scribdassets.com.
//  3) Parse __NEXT_DATA__ / inline JSON if present, otherwise regex over scribdassets.com URLs.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function extractDocId(input: string): { docId: string; canonicalUrl: string } {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const u = new URL(raw);
  if (!/(^|\.)scribd\.com$/i.test(u.hostname)) {
    throw new Error(`Hos bukan Scribd: ${u.hostname}`);
  }
  const parts = u.pathname.split("/").filter(Boolean);
  // Patterns: /document/{id}/{slug}, /presentation/{id}/{slug}, /doc/{id}/{slug},
  //           /embeds/{id}/content, /slideshow/{id}/{slug}
  let docId: string | null = null;
  for (let i = 0; i < parts.length - 1; i++) {
    if (/^(document|documents|presentation|doc|embeds|embed|slideshow|book)$/i.test(parts[i])) {
      if (/^\d+$/.test(parts[i + 1])) { docId = parts[i + 1]; break; }
    }
  }
  if (!docId) {
    // Fallback: first numeric path segment
    const numeric = parts.find((p) => /^\d+$/.test(p));
    if (numeric) docId = numeric;
  }
  if (!docId) throw new Error("Tidak jumpa Scribd document ID dalam URL");
  const canonicalUrl = `https://www.scribd.com/document/${docId}/`;
  return { docId, canonicalUrl };
}

interface Extracted { title: string; pages: string[]; }

function dedupeByPage(found: { page: number; url: string; score: number }[]): string[] {
  const best = new Map<number, { url: string; score: number }>();
  for (const f of found) {
    const cur = best.get(f.page);
    if (!cur || f.score > cur.score) best.set(f.page, { url: f.url, score: f.score });
  }
  return Array.from(best.entries()).sort((a, b) => a[0] - b[0]).map(([, v]) => v.url);
}

function fromHtml(html: string): Extracted | null {
  // Look for page-{N} or pages/{N} patterns inside scribdassets URLs.
  const re = /https?:\/\/[a-z0-9.-]*scribdassets\.com\/[^\s"'<>\\)]+?\.(?:jpg|jpeg|png|webp)/gi;
  const found: { page: number; url: string; score: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[0].replace(/\\\//g, "/");
    // Try several page-number patterns
    const p1 = url.match(/[\/_-]page[_-]?(\d+)/i);
    const p2 = url.match(/\/pages?\/(\d+)/i);
    const p3 = url.match(/_(\d+)\.(?:jpg|jpeg|png|webp)$/i);
    const page = parseInt(p1?.[1] || p2?.[1] || p3?.[1] || "", 10);
    if (!Number.isFinite(page) || page < 1 || page > 2000) continue;
    // Score: higher resolution hints (1500, 2048, original) beat thumbnails
    let score = 1;
    if (/original/i.test(url)) score += 5;
    if (/1500|2048|1920/i.test(url)) score += 3;
    if (/thumb|small/i.test(url)) score -= 2;
    found.push({ page, url, score });
  }
  if (found.length === 0) return null;
  const pages = dedupeByPage(found);
  let title = "scribd";
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const t = html.match(/<title>([^<]+)<\/title>/i);
  const raw = og?.[1] || t?.[1] || "";
  if (raw) title = raw.replace(/\s*[|–-]\s*Scribd.*$/i, "").trim().replace(/[^\w\s.\-]/g, "_").slice(0, 80) || title;
  return { title, pages };
}

async function fetchHtml(url: string, referer: string): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: referer,
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const { url } = body as { url?: string };
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Sila berikan URL Scribd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { docId, canonicalUrl } = extractDocId(url);
    const embedUrl = `https://www.scribd.com/embeds/${docId}/content?start_page=1&view_mode=scroll&access_key=`;

    let extracted: Extracted | null = null;
    const tried: string[] = [];
    const errors: string[] = [];
    let challenge = false;

    for (const u of [embedUrl, canonicalUrl]) {
      tried.push(u);
      try {
        const html = await fetchHtml(u, "https://www.scribd.com/");
        if (/<title>\s*Client Challenge\s*<\/title>/i.test(html) || /\/_fs-ch-[^"']+\/script\.js/i.test(html)) {
          challenge = true;
          errors.push(`${u} → bot challenge (Client Challenge)`);
          continue;
        }
        extracted = fromHtml(html);
        if (extracted && extracted.pages.length > 0) break;
      } catch (e) {
        errors.push(`${u} → ${(e as Error).message}`);
      }
    }

    if (!extracted || extracted.pages.length === 0) {
      const msg = challenge
        ? "Scribd memblokir akses automatik (Client Challenge / anti-bot). Muat turun Scribd dari pelayan tidak disokong buat masa ini — sila guna pelayar untuk simpan dokumen secara manual."
        : "Tiada halaman dijumpai. Dokumen Scribd ini mungkin berbayar/dilindungi atau memerlukan akses login.";
      return new Response(JSON.stringify({
        error: msg, tried, errors, challenge,
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }


    const safeTitle = extracted.title.replace(/[^\w\s.\-]/g, "_").trim().slice(0, 80) || "scribd";
    return new Response(
      JSON.stringify({ title: safeTitle, pages: extracted.pages, canonicalUrl, source: "scribd", docId }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
