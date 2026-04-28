import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Download, BookOpen, Loader2, Sparkles, FileDown } from "lucide-react";

const Index = () => {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");

  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
  const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  const handleDownload = async () => {
    if (!url.trim()) {
      toast.error("Sila masukkan URL AnyFlip");
      return;
    }
    setLoading(true);
    setProgress("Mengesan buku & memuat turun halaman...");

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/anyflip-download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_KEY}`,
          apikey: SUPABASE_KEY,
        },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Ralat tidak diketahui" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const total = res.headers.get("X-Total-Pages");
      const failed = res.headers.get("X-Failed-Pages");
      setProgress("Membina PDF...");

      const blob = await res.blob();
      const dispo = res.headers.get("Content-Disposition") || "";
      const nameMatch = dispo.match(/filename="([^"]+)"/);
      const filename = nameMatch ? nameMatch[1] : "anyflip-book.pdf";

      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);

      toast.success(`Berjaya! ${total} halaman${Number(failed) > 0 ? ` (${failed} gagal)` : ""}`);
      setProgress("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
      setProgress("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-2xl space-y-8">
        <header className="text-center space-y-4">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl text-white"
            style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}
          >
            <BookOpen className="w-8 h-8" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            AnyFlip <span className="bg-clip-text text-transparent" style={{ backgroundImage: "var(--gradient-primary)" }}>Downloader</span>
          </h1>
          <p className="text-muted-foreground text-base sm:text-lg">
            Tukar mana-mana buku AnyFlip kepada PDF dengan satu klik.
          </p>
        </header>

        <Card
          className="p-6 sm:p-8 space-y-5 border-0"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="url">URL Buku AnyFlip</label>
            <Input
              id="url"
              type="url"
              placeholder="https://online.anyflip.com/abcd/efgh/"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
              onKeyDown={(e) => e.key === "Enter" && !loading && handleDownload()}
              className="h-12 text-base"
            />
          </div>

          <Button
            onClick={handleDownload}
            disabled={loading}
            className="w-full h-12 text-base font-semibold text-white border-0"
            style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}
          >
            {loading ? (
              <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> {progress || "Memproses..."}</>
            ) : (
              <><Download className="w-5 h-5 mr-2" /> Muat Turun PDF</>
            )}
          </Button>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
            <Feature icon={<Sparkles className="w-4 h-4" />} text="Auto kesan halaman" />
            <Feature icon={<FileDown className="w-4 h-4" />} text="PDF berkualiti tinggi" />
            <Feature icon={<BookOpen className="w-4 h-4" />} text="Tiada had buku" />
          </div>
        </Card>

        <div className="text-center text-xs text-muted-foreground">
          Tampal URL daripada bar alamat AnyFlip (cth: <code className="px-1.5 py-0.5 rounded bg-muted">online.anyflip.com/xxx/yyy/</code>)
        </div>
      </div>
    </main>
  );
};

const Feature = ({ icon, text }: { icon: React.ReactNode; text: string }) => (
  <div className="flex items-center gap-2 text-sm text-muted-foreground justify-center sm:justify-start">
    <span className="text-primary">{icon}</span>
    <span>{text}</span>
  </div>
);

export default Index;
