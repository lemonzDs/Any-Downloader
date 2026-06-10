import { useState, useMemo, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Download, BookOpen, Presentation, Loader2, ChevronDown, AlertCircle, CheckCircle2, Settings, Eye, RefreshCw, RotateCcw } from "lucide-react";
import { PDFDocument } from "pdf-lib";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const STORAGE_PREFIX = "deck:selected:";

type Source = "anyflip" | "slideshare";

const SOURCE_META: Record<Source, {
  label: string; placeholder: string; metaFn: string; imageFn: string; hint: string;
}> = {
  anyflip: {
    label: "AnyFlip",
    placeholder: "https://anyflip.com/abcd/efgh/",
    metaFn: "anyflip-download",
    imageFn: "anyflip-image",
    hint: "Tampal URL daripada bar alamat AnyFlip (cth: anyflip.com/xxx/yyy/)",
  },
  slideshare: {
    label: "SlideShare",
    placeholder: "https://www.slideshare.net/slideshow/your-deck/123456",
    metaFn: "slideshare-download",
    imageFn: "slideshare-image",
    hint: "Tampal URL pembentangan SlideShare (cth: slideshare.net/slideshow/...)",
  },
};

interface PageDiag {
  index: number;
  originalUrl: string;
  status: "pending" | "ok" | "fail";
  proxyStatus?: number;
  finalUrl?: string;
  referer?: string;
  attempts?: Array<{ url: string; status: number; ms: number; contentType: string | null }>;
  error?: string;
}

interface BookMeta {
  title: string;
  pages: string[];
  canonicalUrl?: string;
}

function proxyUrl(source: Source, pageUrl: string, bust = 0) {
  const base = `${SUPABASE_URL}/functions/v1/${SOURCE_META[source].imageFn}?url=${encodeURIComponent(pageUrl)}`;
  return bust ? `${base}&_b=${bust}` : base;
}

// Parse "1-5, 10-12, 20" (1-indexed). Returns 0-indexed Set within [0, max).
function parseRanges(input: string, max: number): { ok: number[]; bad: string[] } {
  const ok = new Set<number>();
  const bad: string[] = [];
  for (const raw of input.split(/[,\s]+/).filter(Boolean)) {
    const m = raw.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) { bad.push(raw); continue; }
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (lo < 1 || hi > max) { bad.push(raw); continue; }
    for (let i = lo; i <= hi; i++) ok.add(i - 1);
  }
  return { ok: Array.from(ok).sort((a, b) => a - b), bad };
}

async function imageBlobToJpeg(blob: Blob): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("Imej gagal dimuatkan"));
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas tak disokong");
    ctx.drawImage(img, 0, 0);
    const jpegBlob: Blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob gagal"))), "image/jpeg", 0.9)
    );
    const buf = new Uint8Array(await jpegBlob.arrayBuffer());
    return { bytes: buf, w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportDiags(format: "json" | "csv", diags: PageDiag[], canonical?: string) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  if (format === "json") {
    downloadFile(JSON.stringify({ canonical, generatedAt: new Date().toISOString(), pages: diags }, null, 2),
      `anyflip-diagnostics-${ts}.json`, "application/json");
    return;
  }
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["index", "status", "proxyStatus", "originalUrl", "canonical", "finalUrl", "referer", "error", "attempts"];
  const rows = diags.map((d) => [
    d.index + 1, d.status, d.proxyStatus ?? "", d.originalUrl, canonical ?? "",
    d.finalUrl ?? "", d.referer ?? "", d.error ?? "",
    d.attempts ? d.attempts.map((a) => `[${a.status}|${a.ms}ms] ${a.url}`).join(" | ") : "",
  ].map(esc).join(","));
  downloadFile([header.join(","), ...rows].join("\n"), `anyflip-diagnostics-${ts}.csv`, "text/csv");
}

const Index = () => {
  const [source, setSource] = useState<Source>("anyflip");
  const [url, setUrl] = useState("");
  const [concurrency, setConcurrency] = useState(3);
  const [delayMs, setDelayMs] = useState(150);
  const [autoTune, setAutoTune] = useState(true);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [diags, setDiags] = useState<PageDiag[]>([]);
  const [diagOpen, setDiagOpen] = useState(false);
  const [canonical, setCanonical] = useState<{ url: string; chain: string[] } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [book, setBook] = useState<BookMeta | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [thumbBust, setThumbBust] = useState(0);
  const [rangeInput, setRangeInput] = useState("");
  const persistKeyRef = useRef<string | null>(null);

  const loading = loadingMeta || downloading;

  // Persist selection per canonical URL
  useEffect(() => {
    if (!persistKeyRef.current || !book) return;
    try {
      localStorage.setItem(persistKeyRef.current, JSON.stringify(Array.from(selected).sort((a, b) => a - b)));
    } catch { /* ignore quota */ }
  }, [selected, book]);

  const handleLoad = async () => {
    if (!url.trim()) { toast.error(`Sila masukkan URL ${SOURCE_META[source].label}`); return; }
    setLoadingMeta(true); setBook(null); setSelected(new Set()); setDiags([]); setCanonical(null);
    persistKeyRef.current = null;
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/${SOURCE_META[source].metaFn}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const meta: BookMeta = { title: data.title, pages: data.pages, canonicalUrl: data.canonicalUrl };
      setBook(meta);
      if (data.canonicalUrl) setCanonical({ url: data.canonicalUrl, chain: data.redirectChain || [] });

      // Restore saved selection (keyed by canonical URL, else by input URL)
      const key = STORAGE_PREFIX + (data.canonicalUrl || url.trim());
      persistKeyRef.current = key;
      let restored: number[] | null = null;
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) restored = arr.filter((n: unknown) => typeof n === "number" && n >= 0 && n < meta.pages.length);
        }
      } catch { /* ignore */ }
      if (restored && restored.length > 0) {
        setSelected(new Set(restored));
        toast.success(`${meta.pages.length} halaman — pilihan tersimpan dipulihkan (${restored.length})`);
      } else {
        setSelected(new Set(meta.pages.map((_, i) => i)));
        toast.success(`${meta.pages.length} halaman dijumpai — pilih untuk muat turun`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMeta(false);
    }
  };

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });

  const selectAll = () => book && setSelected(new Set(book.pages.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());

  const reloadThumbnails = () => {
    setThumbBust(Date.now());
    toast.success("Memuat semula thumbnail...");
  };

  const applyRange = () => {
    if (!book) return;
    if (!rangeInput.trim()) { toast.error("Masukkan julat (cth: 1-5, 10-12)"); return; }
    const { ok, bad } = parseRanges(rangeInput, book.pages.length);
    if (bad.length) toast.warning(`Diabaikan: ${bad.join(", ")}`);
    if (ok.length === 0) { toast.error("Tiada halaman sah dari julat"); return; }
    setSelected(new Set(ok));
    toast.success(`${ok.length} halaman dipilih dari julat`);
  };

  const updateDiag = (i: number, patch: Partial<PageDiag>) => {
    setDiags((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  const failedIndices = useMemo(
    () => diags.filter((d) => d.status === "fail").map((d) => d.index),
    [diags],
  );
  const failedSet = useMemo(() => new Set(failedIndices), [failedIndices]);

  const selectOnlyFailed = () => {
    if (failedIndices.length === 0) { toast.info("Tiada halaman gagal"); return; }
    setSelected(new Set(failedIndices));
    toast.success(`${failedIndices.length} halaman gagal dipilih`);
  };

  const runDownload = async (targetIndices: number[]) => {
    if (!book) { toast.error("Muat buku dulu"); return; }
    if (targetIndices.length === 0) { toast.error("Tiada halaman untuk dimuat turun"); return; }

    setDownloading(true); setProgress(0); setDiagOpen(false);
    const indices = [...targetIndices].sort((a, b) => a - b);
    const total = indices.length;
    setStatus(`Memuat turun ${total} halaman...`);
    setDiags(indices.map((origIdx) => ({ index: origIdx, originalUrl: book.pages[origIdx], status: "pending" })));

    try {
      const decoded: ({ bytes: Uint8Array; w: number; h: number } | null)[] = new Array(total).fill(null);
      let cursor = 0, done = 0;
      let activeConc = Math.max(1, Math.min(8, concurrency));
      let activePace = Math.max(0, delayMs);
      let throttleUntil = 0;
      let recentOk = 0;

      const onThrottle = () => {
        if (!autoTune) return;
        const backoff = Math.min(8000, 800 + activePace * 2);
        throttleUntil = Date.now() + backoff;
        activePace = Math.min(2000, Math.max(activePace * 2, 400));
        activeConc = Math.max(1, activeConc - 1);
        recentOk = 0;
        setStatus(`Throttle — backoff ${backoff}ms, conc=${activeConc}, delay=${activePace}ms`);
      };
      const onOk = () => {
        if (!autoTune) return;
        recentOk++;
        if (recentOk >= 10 && activePace > delayMs) {
          activePace = Math.max(delayMs, Math.floor(activePace * 0.75));
          recentOk = 0;
        }
      };

      const diagSlot = (origIdx: number) => indices.indexOf(origIdx);

      const work = async () => {
        while (true) {
          const slot = cursor++;
          if (slot >= total) return;
          const origIdx = indices[slot];
          const pageUrl = book.pages[origIdx];
          const wait = Math.max(activePace, throttleUntil - Date.now());
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          try {
            const proxied = proxyUrl(source, pageUrl);
            const finalHdr = source === "anyflip" ? "X-Anyflip-Final-Url" : "X-Slideshare-Final-Url";
            const refHdr = source === "anyflip" ? "X-Anyflip-Referer" : "X-Slideshare-Referer";
            const attHdr = source === "anyflip" ? "X-Anyflip-Attempts" : "X-Slideshare-Attempts";
            const r = await fetch(proxied, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } });
            const finalUrl = r.headers.get(finalHdr) || undefined;
            const referer = r.headers.get(refHdr) || undefined;
            const attemptsRaw = r.headers.get(attHdr);
            const attempts = attemptsRaw ? JSON.parse(attemptsRaw) : undefined;

            if (!r.ok) {
              const errBody = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
              if (r.status === 403 || r.status === 429 || r.status === 503) {
                onThrottle();
                await new Promise((res) => setTimeout(res, throttleUntil - Date.now()));
                const r2 = await fetch(proxied, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } });
                if (r2.ok) {
                  const blob = await r2.blob();
                  decoded[slot] = await imageBlobToJpeg(blob);
                  updateDiag(diagSlot(origIdx), { status: "ok", proxyStatus: r2.status, finalUrl: r2.headers.get(finalHdr) || undefined, referer, attempts });
                  onOk();
                } else {
                  updateDiag(diagSlot(origIdx), { status: "fail", proxyStatus: r2.status, finalUrl, referer, attempts, error: `Retry ${r2.status}` });
                }
              } else {
                updateDiag(diagSlot(origIdx), { status: "fail", proxyStatus: r.status, finalUrl, referer, attempts, error: errBody.error || `HTTP ${r.status}` });
              }
            } else {
              const blob = await r.blob();
              decoded[slot] = await imageBlobToJpeg(blob);
              updateDiag(diagSlot(origIdx), { status: "ok", proxyStatus: r.status, finalUrl, referer, attempts });
              onOk();
            }
          } catch (e) {
            updateDiag(diagSlot(origIdx), { status: "fail", error: e instanceof Error ? e.message : String(e) });
          }
          done++;
          setProgress(Math.round((done / total) * 90));
          if (cursor - done > activeConc) return;
        }
      };
      const startWorkers = Math.max(1, Math.min(8, concurrency));
      const spawn = async (): Promise<void> => { await work(); if (done < total) return spawn(); };
      await Promise.all(Array.from({ length: startWorkers }, () => spawn()));

      const failed = decoded.filter((p) => !p).length;

      setStatus("Membina PDF...");
      const pdf = await PDFDocument.create();
      for (const p of decoded) {
        if (!p) continue;
        const img = await pdf.embedJpg(p.bytes);
        const page = pdf.addPage([p.w, p.h]);
        page.drawImage(img, { x: 0, y: 0, width: p.w, height: p.h });
      }
      if (pdf.getPageCount() === 0) throw new Error("Semua halaman gagal — semak panel diagnostik");
      const bytes = await pdf.save();
      setProgress(100);

      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      const suffix = total === book.pages.length ? "" : `-${total}pages`;
      link.download = `${book.title}${suffix}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);

      if (failed > 0) { toast.warning(`Siap dengan ${failed} halaman gagal — thumbnail ditanda merah`); setDiagOpen(true); }
      else toast.success(`Siap! ${total} halaman`);
      setStatus("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setStatus("");
      setDiagOpen(true);
    } finally {
      setDownloading(false);
      setTimeout(() => setProgress(0), 1500);
    }
  };

  const handleDownload = () => runDownload(Array.from(selected));
  const retryFailed = () => {
    if (failedIndices.length === 0) { toast.info("Tiada halaman gagal"); return; }
    runDownload(failedIndices);
  };

  const failedCount = failedIndices.length;
  const okCount = diags.filter((d) => d.status === "ok").length;

  const allSelected = useMemo(() => book ? selected.size === book.pages.length : false, [book, selected]);

  return (
    <main className="min-h-screen flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-3xl space-y-8">
        <header className="text-center space-y-4">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl text-white"
               style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}>
            <BookOpen className="w-8 h-8" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            AnyFlip <span className="bg-clip-text text-transparent" style={{ backgroundImage: "var(--gradient-primary)" }}>Downloader</span>
          </h1>
          <p className="text-muted-foreground text-base sm:text-lg">
            Preview halaman, pilih yang anda mahu, kemudian muat turun sebagai PDF.
          </p>
        </header>

        <Card className="p-6 sm:p-8 space-y-5 border-0" style={{ boxShadow: "var(--shadow-card)" }}>
          <div className="space-y-2">
            <Label htmlFor="url">URL Buku AnyFlip</Label>
            <div className="flex gap-2">
              <Input id="url" type="url" placeholder="https://anyflip.com/abcd/efgh/" value={url}
                     onChange={(e) => { setUrl(e.target.value); setBook(null); setCanonical(null); }}
                     disabled={loading}
                     onKeyDown={(e) => e.key === "Enter" && !loading && handleLoad()}
                     className="h-12 text-base flex-1" />
              <Button type="button" onClick={handleLoad} disabled={loading} className="h-12 px-6">
                {loadingMeta ? <Loader2 className="w-4 h-4 animate-spin" /> : (<><Eye className="w-4 h-4 mr-2" /> Preview</>)}
              </Button>
            </div>
            {canonical && (
              <div className="text-xs text-muted-foreground break-all">
                <code>{canonical.url}</code>
              </div>
            )}
          </div>

          <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
            <CollapsibleTrigger className="flex items-center justify-between w-full text-sm py-2 px-3 rounded-md bg-muted hover:bg-muted/70 transition">
              <span className="flex items-center gap-2 text-muted-foreground">
                <Settings className="w-4 h-4" /> Tetapan lanjut
              </span>
              <ChevronDown className={`w-4 h-4 transition ${settingsOpen ? "rotate-180" : ""}`} />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="conc" className="text-xs">Concurrency (1–8)</Label>
                  <Input id="conc" type="number" min={1} max={8} value={concurrency}
                         onChange={(e) => setConcurrency(parseInt(e.target.value) || 1)}
                         disabled={loading} className="h-10" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="delay" className="text-xs">Delay antara request (ms)</Label>
                  <Input id="delay" type="number" min={0} max={5000} step={50} value={delayMs}
                         onChange={(e) => setDelayMs(parseInt(e.target.value) || 0)}
                         disabled={loading} className="h-10" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={autoTune} onChange={(e) => setAutoTune(e.target.checked)} disabled={loading} />
                <span>Auto-tune (backoff bila kena 403/429/503)</span>
              </label>
            </CollapsibleContent>
          </Collapsible>

          {book && (
            <div className="space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="text-sm font-medium truncate">
                  {book.title} <span className="text-muted-foreground font-normal">— {book.pages.length} halaman</span>
                </div>
                <div className="flex items-center gap-1 text-xs flex-wrap">
                  <span className="text-muted-foreground mr-1">{selected.size} dipilih</span>
                  <Button size="sm" variant="ghost" onClick={selectAll} disabled={downloading || allSelected}>Semua</Button>
                  <Button size="sm" variant="ghost" onClick={selectNone} disabled={downloading || selected.size === 0}>Kosongkan</Button>
                  <Button size="sm" variant="ghost" onClick={reloadThumbnails} disabled={downloading} title="Muat semula thumbnail">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="Julat halaman: 1-5, 10-12, 20"
                  value={rangeInput}
                  onChange={(e) => setRangeInput(e.target.value)}
                  disabled={downloading}
                  onKeyDown={(e) => e.key === "Enter" && !downloading && applyRange()}
                  className="h-9 text-sm flex-1"
                />
                <Button size="sm" variant="outline" onClick={applyRange} disabled={downloading} className="h-9">
                  Pilih julat
                </Button>
              </div>

              {failedCount > 0 && (
                <div className="flex items-center justify-between gap-2 p-2 rounded-md border border-destructive/40 bg-destructive/5 text-xs">
                  <span className="flex items-center gap-1.5 text-destructive font-medium">
                    <AlertCircle className="w-3.5 h-3.5" /> {failedCount} halaman gagal pada percubaan lalu
                  </span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={selectOnlyFailed} disabled={downloading} className="h-7 text-xs">
                      Pilih sahaja
                    </Button>
                    <Button size="sm" variant="outline" onClick={retryFailed} disabled={downloading} className="h-7 text-xs">
                      <RotateCcw className="w-3 h-3 mr-1" /> Cuba semula
                    </Button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 max-h-[420px] overflow-y-auto p-1 rounded-md border bg-muted/20">
                {book.pages.map((p, i) => {
                  const isSel = selected.has(i);
                  const isFail = failedSet.has(i);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => !downloading && toggle(i)}
                      disabled={downloading}
                      className={`group relative aspect-[3/4] rounded-md overflow-hidden border-2 transition bg-background ${
                        isFail ? "border-destructive ring-2 ring-destructive/40"
                          : isSel ? "border-primary ring-2 ring-primary/30"
                          : "border-border hover:border-primary/50"
                      } ${downloading ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
                    >
                      <img src={proxyUrl(source, p, thumbBust)} alt={`Halaman ${i + 1}`} loading="lazy"
                           className="w-full h-full object-cover" />
                      <div className="absolute top-1 left-1">
                        <Checkbox checked={isSel} className="bg-background/90 border-2" tabIndex={-1} />
                      </div>
                      {isFail && (
                        <div className="absolute top-1 right-1 bg-destructive text-destructive-foreground rounded-full p-0.5 shadow">
                          <AlertCircle className="w-3 h-3" />
                        </div>
                      )}
                      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 text-[10px] font-medium text-white text-center">
                        {i + 1}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <Button onClick={handleDownload} disabled={loading || !book || selected.size === 0}
                  className="w-full h-12 text-base font-semibold text-white border-0"
                  style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}>
            {downloading ? (<><Loader2 className="w-5 h-5 mr-2 animate-spin" /> {status || "Memproses..."}</>)
                         : (<><Download className="w-5 h-5 mr-2" /> {book
                            ? (allSelected ? `Muat Turun Semua (${book.pages.length})` : `Muat Turun ${selected.size} Halaman`)
                            : "Muat Turun PDF"}</>)}
          </Button>

          {progress > 0 && <Progress value={progress} className="h-2" />}

          {diags.length > 0 && (
            <Collapsible open={diagOpen} onOpenChange={setDiagOpen}>
              <CollapsibleTrigger className="flex items-center justify-between w-full text-sm py-2 px-3 rounded-md bg-muted hover:bg-muted/70 transition">
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600" /> {okCount} ok
                  {failedCount > 0 && (<><AlertCircle className="w-4 h-4 text-destructive ml-2" /> {failedCount} gagal</>)}
                </span>
                <ChevronDown className={`w-4 h-4 transition ${diagOpen ? "rotate-180" : ""}`} />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 space-y-2">
                <div className="flex gap-2 flex-wrap">
                  <Button type="button" size="sm" variant="outline" onClick={() => exportDiags("json", diags, canonical?.url)}>
                    Export JSON
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => exportDiags("csv", diags, canonical?.url)}>
                    Export CSV
                  </Button>
                  {failedCount > 0 && (
                    <Button type="button" size="sm" variant="outline" onClick={retryFailed} disabled={downloading}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1" /> Cuba semula {failedCount} gagal
                    </Button>
                  )}
                </div>
                <div className="space-y-2 max-h-80 overflow-y-auto">
                {diags.map((d) => (
                  <div key={d.index} className={`text-xs p-2 rounded border ${
                    d.status === "fail" ? "border-destructive/40 bg-destructive/5" :
                    d.status === "ok" ? "border-border bg-background" : "border-border bg-muted/30"
                  }`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono">#{d.index + 1}</span>
                      <span className={d.status === "fail" ? "text-destructive font-medium" : "text-muted-foreground"}>
                        {d.status === "pending" ? "..." : d.status === "ok" ? `OK ${d.proxyStatus}` : `FAIL ${d.proxyStatus ?? ""}`}
                      </span>
                    </div>
                    <div className="mt-1 break-all text-muted-foreground">{d.originalUrl}</div>
                    {d.finalUrl && d.finalUrl !== d.originalUrl && (
                      <div className="mt-1 break-all"><span className="text-muted-foreground">→ final:</span> {d.finalUrl}</div>
                    )}
                    {d.referer && <div className="mt-1 break-all"><span className="text-muted-foreground">referer:</span> {d.referer}</div>}
                    {d.error && <div className="mt-1 text-destructive break-all">error: {d.error}</div>}
                    {d.attempts && d.status === "fail" && (
                      <div className="mt-1 space-y-0.5">
                        {d.attempts.map((a, j) => (
                          <div key={j} className="font-mono text-[10px] text-muted-foreground break-all">
                            [{a.status}] {a.ms}ms {a.url}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </Card>

        <div className="text-center text-xs text-muted-foreground">
          Tampal URL daripada bar alamat AnyFlip (cth: <code className="px-1.5 py-0.5 rounded bg-muted">anyflip.com/xxx/yyy/</code>)
        </div>
      </div>
    </main>
  );
};

export default Index;
