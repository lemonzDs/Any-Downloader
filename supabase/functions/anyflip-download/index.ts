// AnyFlip downloader edge function
// Fetches all pages of an AnyFlip book and returns a combined PDF

import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface BookConfig {
  bookConfig: {
    totalPageCount?: number;
    title?: string;
  };
  bookId?: string;
}

// Parse AnyFlip URL to extract base book path
// Examples:
//   https://online.anyflip.com/abcd/efgh/mobile/index.html
//   https://anyflip.com/abcd/efgh/
function parseAnyflipUrl(url: string): { baseUrl: string; userId: string; bookId: string } {
  const cleaned = url.trim().replace(/\/(mobile|index)\.html?.*$/i, "").replace(/\/+$/, "");
  const m = cleaned.match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/?#]+)/i);
  if (!m) throw new Error("URL AnyFlip tidak sah. Contoh: https://online.anyflip.com/abcd/efgh/");
  return { baseUrl: `${m[1]}/${m[2]}/${m[3]}`, userId: m[2], bookId: m[3] };
}

// Fetch the book's mobile/javascript/config.js to discover page count + title
async function fetchBookConfig(baseUrl: string): Promise<{ totalPages: number; title: string }> {
  // Try a few known config locations
  const candidates = [
    `${baseUrl}/mobile/javascript/config.js`,
    `${baseUrl}/javascript/config.js`,
    `${baseUrl}/files/mobile/javascript/config.js`,
  ];

  let configText = "";
  for (const u of candidates) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r.ok) {
        configText = await r.text();
        if (configText.length > 100) break;
      }
    } catch (_) { /* keep trying */ }
  }

  let totalPages = 0;
  let title = "anyflip-book";

  if (configText) {
    const tp = configText.match(/totalPageCount\s*[:=]\s*["']?(\d+)["']?/i);
    if (tp) totalPages = parseInt(tp[1], 10);
    const tt = configText.match(/title\s*[:=]\s*["']([^"']+)["']/i);
    if (tt) title = tt[1].replace(/[^\w\s.-]/g, "_").slice(0, 80);
  }

  // Fallback: probe pages until 404
  if (!totalPages) {
    let lo = 1, hi = 1024;
    // exponential search
    while (await pageExists(baseUrl, hi) && hi < 8192) { lo = hi; hi *= 2; }
    // binary search between lo and hi
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (await pageExists(baseUrl, mid)) lo = mid; else hi = mid - 1;
    }
    totalPages = lo;
  }

  return { totalPages, title };
}

async function pageExists(baseUrl: string, n: number): Promise<boolean> {
  const url = `${baseUrl}/files/mobile/${n}.jpg`;
  try {
    const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
    return r.ok;
  } catch { return false; }
}

async function fetchPageImage(baseUrl: string, n: number): Promise<Uint8Array | null> {
  // Try mobile jpg, then large jpg
  const candidates = [
    `${baseUrl}/files/mobile/${n}.jpg`,
    `${baseUrl}/files/large/${n}.jpg`,
    `${baseUrl}/files/mobile/${n}.webp`,
  ];
  for (const u of candidates) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r.ok) {
        const ct = r.headers.get("content-type") || "";
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength > 500 && (ct.includes("image") || u.endsWith(".jpg"))) {
          return buf;
        }
      }
    } catch (_) { /* try next */ }
  }
  return null;
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
    console.log("Base URL:", baseUrl);

    const { totalPages, title } = await fetchBookConfig(baseUrl);
    console.log(`Found ${totalPages} pages, title: ${title}`);

    if (!totalPages) {
      return new Response(JSON.stringify({ error: "Tak dapat kesan jumlah halaman buku ini" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch pages with limited concurrency
    const pages: (Uint8Array | null)[] = new Array(totalPages).fill(null);
    const concurrency = 8;
    let cursor = 0;
    let failed = 0;

    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= totalPages) return;
        const buf = await fetchPageImage(baseUrl, idx + 1);
        if (!buf) { failed++; console.warn(`Page ${idx + 1} failed`); }
        pages[idx] = buf;
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(`Downloaded ${totalPages - failed}/${totalPages} pages`);

    // Build PDF
    const pdf = await PDFDocument.create();
    for (let i = 0; i < pages.length; i++) {
      const buf = pages[i];
      if (!buf) continue;
      try {
        let img;
        // pdf-lib supports JPG and PNG; try JPG first
        try { img = await pdf.embedJpg(buf); }
        catch { img = await pdf.embedPng(buf); }
        const page = pdf.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      } catch (e) {
        console.warn(`Embed failed for page ${i + 1}:`, (e as Error).message);
      }
    }

    const pdfBytes = await pdf.save();
    const filename = `${title || "anyflip-book"}.pdf`;

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Total-Pages": String(totalPages),
        "X-Failed-Pages": String(failed),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
