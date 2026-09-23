import { useEffect, useState } from "react";
import { Download, Eye, FileWarning } from "lucide-react";
import { Button, Loading } from "./ui";
import { formatBytes, openPublicFile } from "./drive";

/** Public share page (/arquivo/<token>): works without signing in. */
export function PublicFile({ token }: { token: string }) {
  const [file, setFile] = useState<{
    name: string;
    content_type: string;
    size_bytes: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    openPublicFile(token)
      .then((f) => {
        setFile(f);
        document.title = `${f.name} — Workspace`;
      })
      .catch((e) => setError((e as Error).message));
  }, [token]);
  async function open(inline: boolean) {
    const tab = inline ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    setBusy(true);
    try {
      // Signed URLs expire in minutes, so each click asks for a fresh one.
      const { url } = await openPublicFile(token, inline);
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="public-file-page">
      <div className="public-file-card">
        <span className="brand">
          <span className="brand-mark">W</span>
          <span>
            workspace<span className="brand-period">.</span>
          </span>
        </span>
        {error ? (
          <div className="public-file-error">
            <FileWarning size={30} />
            <h1>Arquivo indisponível</h1>
            <p>
              {error} O link pode ter sido desativado por quem o compartilhou.
            </p>
          </div>
        ) : file ? (
          <>
            <small>ARQUIVO COMPARTILHADO</small>
            <h1>{file.name}</h1>
            <p>{formatBytes(file.size_bytes)}</p>
            <div className="public-file-actions">
              <Button
                className="btn primary"
                loading={busy}
                onClick={() => void open(false)}
              >
                <Download size={17} /> Baixar
              </Button>
              <Button
                className="btn secondary"
                disabled={busy}
                onClick={() => void open(true)}
              >
                <Eye size={17} /> Visualizar
              </Button>
            </div>
          </>
        ) : (
          <Loading compact />
        )}
      </div>
    </div>
  );
}
