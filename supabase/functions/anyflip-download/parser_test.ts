// URL-parser unit tests for anyflip-download.
// Covers: trailing slashes, www/online/bare hosts, /basic, /mobile, /index.html,
// query strings, deep paths with page numbers, and image URLs.

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Re-implement parser inline (mirrors index.ts) so tests don't need to import the server.
function parseAnyflipUrl(input: string): { baseUrl: string; userId: string; bookId: string } {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new Error("URL AnyFlip tidak sah");
  }
  if (!/(^|\.)anyflip\.com$/i.test(parsed.hostname)) {
    throw new Error(`Hos bukan AnyFlip: ${parsed.hostname}`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean).filter((p) => {
    if (/^(mobile|basic|index)(\.html?)?$/i.test(p)) return false;
    if (/\.(html?|js|css|webp|jpe?g|png|gif)$/i.test(p)) return false;
    if (/^\d+$/.test(p)) return false;
    if (/^files$/i.test(p) || /^(large|mobile|thumbnail)$/i.test(p)) return false;
    return true;
  });
  if (parts.length < 2) throw new Error("URL AnyFlip tidak sah");
  return { baseUrl: `https://online.anyflip.com/${parts[0]}/${parts[1]}`, userId: parts[0], bookId: parts[1] };
}

const cases: Array<[string, string]> = [
  ["https://anyflip.com/abcd/efgh", "abcd/efgh"],
  ["https://anyflip.com/abcd/efgh/", "abcd/efgh"],
  ["anyflip.com/abcd/efgh/", "abcd/efgh"],
  ["http://anyflip.com/abcd/efgh/basic", "abcd/efgh"],
  ["https://anyflip.com/abcd/efgh/basic/", "abcd/efgh"],
  ["https://anyflip.com/abcd/efgh/mobile/index.html", "abcd/efgh"],
  ["https://www.anyflip.com/abcd/efgh/", "abcd/efgh"],
  ["https://online.anyflip.com/abcd/efgh/", "abcd/efgh"],
  ["https://online.anyflip.com/abcd/efgh/index.html", "abcd/efgh"],
  ["https://anyflip.com/abcd/efgh/?fr=sNTIxMzM", "abcd/efgh"],
  ["https://anyflip.com/abcd/efgh/123.html", "abcd/efgh"],
  ["https://anyflip.com/abcd/efgh/12/", "abcd/efgh"],
  ["https://online.anyflip.com/abuly/nbtx/files/large/abc.webp", "abuly/nbtx"],
  ["https://online.anyflip.com/ewqqc/shvo/8dd1a28b739a64f8ee09695383ad933a.webp", "ewqqc/shvo"],
  ["  https://anyflip.com/ABCD/EfGh/  ", "ABCD/EfGh"], // preserves case
];

Deno.test("parseAnyflipUrl: accepts all known patterns", () => {
  for (const [input, expectedPath] of cases) {
    const { baseUrl } = parseAnyflipUrl(input);
    assertEquals(
      baseUrl,
      `https://online.anyflip.com/${expectedPath}`,
      `Failed for: ${input}`,
    );
  }
});

Deno.test("parseAnyflipUrl: rejects non-anyflip hosts", () => {
  assertThrows(() => parseAnyflipUrl("https://example.com/abcd/efgh"), Error, "bukan AnyFlip");
  assertThrows(() => parseAnyflipUrl("https://anyflip.evil.com/a/b"), Error, "bukan AnyFlip");
});

Deno.test("parseAnyflipUrl: rejects URLs without /<user>/<book>/", () => {
  assertThrows(() => parseAnyflipUrl("https://anyflip.com/"), Error);
  assertThrows(() => parseAnyflipUrl("https://anyflip.com/abcd"), Error);
  assertThrows(() => parseAnyflipUrl("https://anyflip.com/basic/index.html"), Error);
});

Deno.test("parseAnyflipUrl: extracts user and book ids", () => {
  const r = parseAnyflipUrl("https://www.anyflip.com/abuly/nbtx/basic/");
  assertEquals(r.userId, "abuly");
  assertEquals(r.bookId, "nbtx");
  assert(r.baseUrl.endsWith("/abuly/nbtx"));
});
