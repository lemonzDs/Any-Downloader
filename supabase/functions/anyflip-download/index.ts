// AnyFlip downloader edge function
// Reads htmlConfig.fliphtml5_pages from config.js, fetches each image (with Referer),
// converts WebP -> PNG when needed, and merges into a PDF.

import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
import decodeWebp from "npm:@jsquash/webp@1.4.0/decode";
import encodeJpeg from "npm:@jsquash/jpeg@1.5.0/encode";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Parse AnyFlip URL → base book URL on online.anyflip.com
function parseAnyflipUrl(input: string): { baseUrl: string; referer: string } {
  const cleaned = input.trim()
    .replace(/[?#].*$/, "")
    .replace(/\/(mobile|basic|index)(\.html?)?\/?$/i, "")
    .replace(/\/+$/, "");
  const m = cleaned.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/?#]+)/i);
  if (!m) throw new Error("URL AnyFlip tidak sah. Contoh: https://anyflip.com/abcd/efgh/");
  const userId = m[1];
  const bookId = m[2];
  const baseUrl = `https://online.anyflip.com/${userId}/${bookId}`;
  return { baseUrl, referer: `${baseUrl}/` };
}

interface PageInfo { url: string; }

async function fetchConfig(baseUrl: string): Promise<{ pages: PageInfo[]; title: string }> {
  const candidates = [
    `${baseUrl}/mobile/javascript/config.js`,
    `${baseUrl}/javascript/config.js`,
  ];
  let text = "";
  let lastErr = "";
  for (const u of candidates) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA, Referer: `${baseUrl}/` } });
      if (r.ok) {
        text = await r.text();
        if (text.length > 200) break;
      } else {
        lastErr = `${u} → ${r.status}`;
      }
    } catch (e) { lastErr = (e as Error).message; }
  }
  if (!text) throw new Error(`Tidak dapat capai config buku. ${lastErr}`);

  // Find every "n":["..."] in fliphtml5_pages
  const pageRegex = /"n"\s*:\s*\[\s*"([^"]+)"/g;
  const pages: PageInfo[] = [];
  let m: RegExpExecArray | null;
  while ((m = pageRegex.exec(text)) !== null) {
    const rel = m[1].replace(/\\\//g, "/").replace(/^\.\.\//, "");
    pages.push({ url: `${baseUrl}/${rel}` });
  }

  let title = "anyflip-book";
  const tMatch = text.match(/"?title"?\s*:\s*"([^"]{1,200})"/i);
  if (tMatch) title = tMatch[1].replace(/[^\w\s.\-]/g, "_").trim().slice(0, 80) || title;

  return { pages, title };
}

async function fetchImage(url: string, referer: string): Promise<{ bytes: Uint8Array; type: "jpg" | "png" | "webp" } | null> {
  const tries = [url];
  if (url.endsWith(".webp")) tries.push(url.replace(/\.webp$/, ".jpg"));
  for (const u of tries) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA, Referer: referer } });
      if (!r.ok) continue;
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.byteLength < 200) continue;
      if (ct.includes("webp") || u.endsWith(".webp")) return { bytes, type: "webp" };
      if (ct.includes("png") || u.endsWith(".png")) return { bytes, type: "png" };
      return { bytes, type: "jpg" };
    } catch (_) { /* try next */ }
  }
  return null;
}

async function toPngOrJpg(img: { bytes: Uint8Array; type: "jpg" | "png" | "webp" }): Promise<{ bytes: Uint8Array; type: "jpg" | "png" }> {
  if (img.type === "jpg" || img.type === "png") return img;
  const imageData = await decodeWebp(img.bytes); // { data, width, height }
  const jpeg = await encodeJpeg(imageData, { quality: 88 });
  return { bytes: new Uint8Array(jpeg), type: "jpg" };
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

    const { baseUrl, referer } = parseAnyflipUrl(url);
    console.log("Base:", baseUrl);

    const { pages, title } = await fetchConfig(baseUrl);
    console.log(`Pages: ${pages.length}, title: ${title}`);

    if (pages.length === 0) {
      return new Response(JSON.stringify({ error: "Tiada halaman dijumpai untuk buku ini" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const total = pages.length;
    const results: ({ bytes: Uint8Array; type: "jpg" | "png" } | null)[] = new Array(total).fill(null);
    let cursor = 0;
    let failed = 0;
    const concurrency = 4;

    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= total) return;
        try {
          const raw = await fetchImage(pages[idx].url, referer);
          if (!raw) { failed++; console.warn(`Page ${idx + 1}: fetch failed`); continue; }
          results[idx] = await toPngOrJpg(raw);
        } catch (e) {
          failed++;
          console.warn(`Page ${idx + 1}: ${(e as Error).message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(`Done ${total - failed}/${total}`);

    const pdf = await PDFDocument.create();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      try {
        const img = r.type === "jpg" ? await pdf.embedJpg(r.bytes) : await pdf.embedPng(r.bytes);
        const page = pdf.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      } catch (e) {
        console.warn(`Embed page ${i + 1} failed: ${(e as Error).message}`);
      }
    }

    if (pdf.getPageCount() === 0) {
      return new Response(JSON.stringify({ error: "Semua halaman gagal dimuat turun" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const pdfBytes = await pdf.save();
    const filename = `${title}.pdf`;

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Total-Pages": String(total),
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
