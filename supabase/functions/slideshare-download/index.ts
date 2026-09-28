// SlideShare metadata fetcher — extracts slide image URLs from a slideshare.net presentation.
// Strategy:
//  1) Fetch the public HTML with a desktop UA.
//  2) Try to parse __NEXT_DATA__ JSON (modern SlideShare).
//  3) Fallback to regex over CDN URLs (image.slidesharecdn.com/.../-N-{2048|1024|638}.jpg).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function normaliseUrl(input: string): URL {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const u = new URL(raw);
  if (!/(^|\.)slideshare\.net$/i.test(u.hostname)) {
    throw new Error(`Hos bukan SlideShare: ${u.hostname}`);
  }
  // Drop tracking query
  u.search = "";
  u.hash = "";
  return u;
}

interface Extracted {
  title: string;
  pages: string[];
}

function fromNextData(html: string): Extracted | null {
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  let data: unknown;
  try { data = JSON.parse(m[1]); } catch { return null; }

  // Walk to find arrays of image URLs that look like slideshare CDN slides.
  const found: { num: number; url: string; res: number }[] = [];
  let title = "";

  const visit = (node: unknown) => {
    if (!node) return;
    if (typeof node === "string") {
      const sm = node.match(/^https?:\/\/image\.slidesharecdn\.com\/[^\s"']+-(\d+)-(\d+)\.jpg(?:\?[^\s"']*)?$/i);
      if (sm) found.push({ num: parseInt(sm[1], 10), res: parseInt(sm[2], 10), url: node });
      return;
    }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (!title && (k === "title" || k === "name") && typeof v === "string" && v.length > 2 && v.length < 200) {
          title = v;
        }
        visit(v);
      }
    }
  };
  visit(data);

  if (found.length === 0) return null;
  const best = new Map<number, { url: string; res: number }>();
  for (const f of found) {
    const cur = best.get(f.num);
    if (!cur || f.res > cur.res) best.set(f.num, { url: f.url, res: f.res });
  }
  const pages = Array.from(best.entries()).sort((a, b) => a[0] - b[0]).map(([, v]) => v.url);
  return { title: title || "slideshare", pages };
}

function fromRegex(html: string): Extracted | null {
  const re = /https?:\/\/image\.slidesharecdn\.com\/[^\s"'<>\\]+?-(\d+)-(2048|1024|638)\.jpg/gi;
  const best = new Map<number, { url: string; res: number; base: string }>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[0];
    const num = parseInt(m[1], 10);
    const res = parseInt(m[2], 10);
    // base = everything before -N-RES.jpg, used to ensure consistent deck
    const base = url.replace(/-\d+-(2048|1024|638)\.jpg.*$/, "");
    const cur = best.get(num);
    if (!cur || res > cur.res) best.set(num, { url, res, base });
  }
  if (best.size === 0) return null;

  // Pick the dominant base (in case multiple decks are referenced)
  const baseCounts = new Map<string, number>();
  for (const v of best.values()) baseCounts.set(v.base, (baseCounts.get(v.base) || 0) + 1);
  const dominantBase = [...baseCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const filtered = [...best.entries()].filter(([, v]) => v.base === dominantBase);
  filtered.sort((a, b) => a[0] - b[0]);
  const pages = filtered.map(([, v]) => v.url);

  let title = "slideshare";
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const t = html.match(/<title>([^<]+)<\/title>/i);
  const raw = og?.[1] || t?.[1] || "";
  if (raw) title = raw.replace(/\s*[|–-]\s*SlideShare.*$/i, "").trim().replace(/[^\w\s.\-]/g, "_").slice(0, 80) || title;

  return { title, pages };
}

function detectTotal(html: string): number {
  const keys = /"(?:totalSlides|total_slides|slideCount|slide_count|numSlides|totalPages|pageCount)"\s*:\s*"?(\d{1,4})/gi;
  let max = 0; let m: RegExpExecArray | null;
  while ((m = keys.exec(html)) !== null) max = Math.max(max, parseInt(m[1], 10));
  const t = html.match(/(\d{1,4})\s+slides?\b/i);
  if (!max && t) max = parseInt(t[1], 10);
  return max > 0 && max < 2000 ? max : 0;
}

async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA, Referer: "https://www.slideshare.net/" } });
    return r.ok;
  } catch { return false; }
}

async function expandPages(pages: string[], html: string): Promise<string[]> {
  const sample = pages[0];
  const m = sample.match(/^(.*)-(\d+)-(2048|1024|638)\.jpg(\?.*)?$/);
  if (!m) return pages;
  const [, base, , res, q = ""] = m;
  const make = (n: number) => `${base}-${n}-${res}.jpg${q}`;
  const known = new Map<number, string>();
  for (const p of pages) {
    const pm = p.match(/-(\d+)-(?:2048|1024|638)\.jpg/);
    if (pm && p.startsWith(base)) known.set(parseInt(pm[1], 10), p);
  }
  let total = detectTotal(html);
  if (!total) {
    // Probe forward in batches until a whole batch misses.
    let n = Math.max(1, ...known.keys()) + 1;
    const BATCH = 10;
    while (n < 1000) {
      const nums = Array.from({ length: BATCH }, (_, i) => n + i);
      const ok = await Promise.all(nums.map((k) => known.has(k) ? true : exists(make(k))));
      const lastOk = nums.filter((_, i) => ok[i]).pop();
      if (lastOk) total = lastOk;
      if (!ok[ok.length - 1]) break;
      n += BATCH;
    }
    total = Math.max(total, ...known.keys());
  }
  const out: string[] = [];
  for (let i = 1; i <= total; i++) out.push(known.get(i) || make(i));
  return out.length ? out : pages;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const { url } = body as { url?: string };
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Sila berikan URL SlideShare" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const target = normaliseUrl(url);
    const canonicalUrl = target.toString();

    const r = await fetch(canonicalUrl, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `Gagal capai SlideShare (HTTP ${r.status})` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const html = await r.text();

    if (/<title>\s*Client Challenge\s*<\/title>/i.test(html) || /\/_fs-ch-[^/]+\//.test(html)) {
      return new Response(JSON.stringify({ error: "SlideShare sedang menyekat permintaan dari server (Client Challenge). Sila cuba lagi sebentar." }), {
        status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const extracted = fromNextData(html) || fromRegex(html);
    if (!extracted || extracted.pages.length === 0) {
      return new Response(JSON.stringify({ error: "Tiada slide dijumpai dalam halaman SlideShare" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // HTML often only lists the first few slides (rest lazy-loaded). Use the
    // total count if present, then probe the CDN for more slides.
    extracted.pages = await expandPages(extracted.pages, html);

    const safeTitle = extracted.title.replace(/[^\w\s.\-]/g, "_").trim().slice(0, 80) || "slideshare";
    return new Response(
      JSON.stringify({ title: safeTitle, pages: extracted.pages, canonicalUrl, source: "slideshare" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
