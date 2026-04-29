import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { Download, BookOpen, Loader2, Sparkles, FileDown, ChevronDown, AlertCircle, CheckCircle2 } from "lucide-react";
import { PDFDocument } from "pdf-lib";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

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

const Index = () => {
  const [url, setUrl] = useState("");
  const [concurrency, setConcurrency] = useState(3);
  const [delayMs, setDelayMs] = useState(150);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [diags, setDiags] = useState<PageDiag[]>([]);
  const [diagOpen, setDiagOpen] = useState(false);

  const updateDiag = (i: number, patch: Partial<PageDiag>) => {
    setDiags((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  const handleDownload = async () => {
    if (!url.trim()) { toast.error("Sila masukkan URL AnyFlip"); return; }
    setLoading(true); setProgress(0); setStatus("Mengesan buku..."); setDiags([]); setDiagOpen(false);

    try {
      const metaRes = await fetch(`${SUPABASE_URL}/functions/v1/anyflip-download`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!metaRes.ok) {
        const err = await metaRes.json().catch(() => ({ error: "Ralat" }));
        throw new Error(err.error || `HTTP ${metaRes.status}`);
      }
      const { title, pages } = await metaRes.json() as { title: string; pages: string[] };
      const total = pages.length;
      setStatus(`Memuat turun ${total} halaman...`);
      setDiags(pages.map((p, i) => ({ index: i, originalUrl: p, status: "pending" })));

      const decoded: ({ bytes: Uint8Array; w: number; h: number } | null)[] = new Array(total).fill(null);
      let cursor = 0, done = 0;
      const conc = Math.max(1, Math.min(8, concurrency));
      const pacing = Math.max(0, delayMs);

      const work = async () => {
        while (true) {
          const i = cursor++;
          if (i >= total) return;
          if (pacing > 0) await new Promise((r) => setTimeout(r, pacing));
          try {
            const proxied = `${SUPABASE_URL}/functions/v1/anyflip-image?url=${encodeURIComponent(pages[i])}`;
            const r = await fetch(proxied, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } });
            const finalUrl = r.headers.get("X-Anyflip-Final-Url") || undefined;
            const referer = r.headers.get("X-Anyflip-Referer") || undefined;
            const attemptsRaw = r.headers.get("X-Anyflip-Attempts");
            const attempts = attemptsRaw ? JSON.parse(attemptsRaw) : undefined;

            if (!r.ok) {
              const errBody = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
              updateDiag(i, {
                status: "fail", proxyStatus: r.status, finalUrl, referer, attempts,
                error: errBody.error || `HTTP ${r.status}`,
              });
            } else {
              const blob = await r.blob();
              decoded[i] = await imageBlobToJpeg(blob);
              updateDiag(i, { status: "ok", proxyStatus: r.status, finalUrl, referer, attempts });
            }
          } catch (e) {
            updateDiag(i, { status: "fail", error: e instanceof Error ? e.message : String(e) });
          }
          done++;
          setProgress(Math.round((done / total) * 90));
        }
      };
      await Promise.all(Array.from({ length: conc }, () => work()));

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
      link.download = `${title}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);

      if (failed > 0) {
        toast.warning(`Siap dengan ${failed} halaman gagal — buka panel diagnostik`);
        setDiagOpen(true);
      } else {
        toast.success(`Siap! ${total} halaman`);
      }
      setStatus("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setStatus("");
      setDiagOpen(true);
    } finally {
      setLoading(false);
      setTimeout(() => setProgress(0), 1500);
    }
  };

  const failedCount = diags.filter((d) => d.status === "fail").length;
  const okCount = diags.filter((d) => d.status === "ok").length;

  return (
    <main className="min-h-screen flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-2xl space-y-8">
        <header className="text-center space-y-4">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl text-white"
               style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}>
            <BookOpen className="w-8 h-8" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            AnyFlip <span className="bg-clip-text text-transparent" style={{ backgroundImage: "var(--gradient-primary)" }}>Downloader</span>
          </h1>
          <p className="text-muted-foreground text-base sm:text-lg">
            Tukar mana-mana buku AnyFlip kepada PDF dengan satu klik.
          </p>
        </header>

        <Card className="p-6 sm:p-8 space-y-5 border-0" style={{ boxShadow: "var(--shadow-card)" }}>
          <div className="space-y-2">
            <Label htmlFor="url">URL Buku AnyFlip</Label>
            <Input id="url" type="url" placeholder="https://anyflip.com/abcd/efgh/" value={url}
                   onChange={(e) => setUrl(e.target.value)} disabled={loading}
                   onKeyDown={(e) => e.key === "Enter" && !loading && handleDownload()}
                   className="h-12 text-base" />
          </div>

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

          <Button onClick={handleDownload} disabled={loading}
                  className="w-full h-12 text-base font-semibold text-white border-0"
                  style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}>
            {loading ? (<><Loader2 className="w-5 h-5 mr-2 animate-spin" /> {status || "Memproses..."}</>)
                     : (<><Download className="w-5 h-5 mr-2" /> Muat Turun PDF</>)}
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
              <CollapsibleContent className="mt-3 space-y-2 max-h-80 overflow-y-auto">
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
              </CollapsibleContent>
            </Collapsible>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
            <Feature icon={<Sparkles className="w-4 h-4" />} text="Auto kesan halaman" />
            <Feature icon={<FileDown className="w-4 h-4" />} text="PDF berkualiti tinggi" />
            <Feature icon={<BookOpen className="w-4 h-4" />} text="Diagnostik penuh" />
          </div>
        </Card>

        <div className="text-center text-xs text-muted-foreground">
          Tampal URL daripada bar alamat AnyFlip (cth: <code className="px-1.5 py-0.5 rounded bg-muted">anyflip.com/xxx/yyy/</code>)
        </div>
      </div>
    </main>
  );
};

const Feature = ({ icon, text }: { icon: React.ReactNode; text: string }) => (
  <div className="flex items-center gap-2 text-sm text-muted-foreground justify-center sm:justify-start">
    <span className="text-primary">{icon}</span><span>{text}</span>
  </div>
);

export default Index;
