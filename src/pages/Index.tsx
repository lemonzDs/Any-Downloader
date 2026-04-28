import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { Download, BookOpen, Loader2, Sparkles, FileDown } from "lucide-react";
import { PDFDocument } from "pdf-lib";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Decode WebP/JPG via browser <img>+canvas → JPEG bytes for pdf-lib
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
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");

  const handleDownload = async () => {
    if (!url.trim()) { toast.error("Sila masukkan URL AnyFlip"); return; }
    setLoading(true); setProgress(0); setStatus("Mengesan buku...");

    try {
      // 1. Fetch metadata
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

      // 2. Fetch + decode each page (concurrency 3)
      const decoded: ({ bytes: Uint8Array; w: number; h: number } | null)[] = new Array(total).fill(null);
      let cursor = 0, done = 0, failed = 0;
      const work = async () => {
        while (true) {
          const i = cursor++;
          if (i >= total) return;
          try {
            const proxied = `${SUPABASE_URL}/functions/v1/anyflip-image?url=${encodeURIComponent(pages[i])}`;
            const r = await fetch(proxied, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const blob = await r.blob();
            decoded[i] = await imageBlobToJpeg(blob);
          } catch (e) {
            failed++;
            console.warn(`Page ${i + 1}:`, e);
          }
          done++;
          setProgress(Math.round((done / total) * 90));
        }
      };
      await Promise.all([work(), work(), work()]);

      // 3. Build PDF
      setStatus("Membina PDF...");
      const pdf = await PDFDocument.create();
      for (const p of decoded) {
        if (!p) continue;
        const img = await pdf.embedJpg(p.bytes);
        const page = pdf.addPage([p.w, p.h]);
        page.drawImage(img, { x: 0, y: 0, width: p.w, height: p.h });
      }
      if (pdf.getPageCount() === 0) throw new Error("Semua halaman gagal");
      const bytes = await pdf.save();
      setProgress(100);

      // 4. Download
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${title}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);

      toast.success(`Siap! ${total - failed}/${total} halaman`);
      setStatus("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setStatus("");
    } finally {
      setLoading(false);
      setTimeout(() => setProgress(0), 1500);
    }
  };

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
            <label className="text-sm font-medium" htmlFor="url">URL Buku AnyFlip</label>
            <Input id="url" type="url" placeholder="https://anyflip.com/abcd/efgh/" value={url}
                   onChange={(e) => setUrl(e.target.value)} disabled={loading}
                   onKeyDown={(e) => e.key === "Enter" && !loading && handleDownload()}
                   className="h-12 text-base" />
          </div>

          <Button onClick={handleDownload} disabled={loading}
                  className="w-full h-12 text-base font-semibold text-white border-0"
                  style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}>
            {loading ? (<><Loader2 className="w-5 h-5 mr-2 animate-spin" /> {status || "Memproses..."}</>)
                     : (<><Download className="w-5 h-5 mr-2" /> Muat Turun PDF</>)}
          </Button>

          {progress > 0 && <Progress value={progress} className="h-2" />}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
            <Feature icon={<Sparkles className="w-4 h-4" />} text="Auto kesan halaman" />
            <Feature icon={<FileDown className="w-4 h-4" />} text="PDF berkualiti tinggi" />
            <Feature icon={<BookOpen className="w-4 h-4" />} text="Tiada had buku" />
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
