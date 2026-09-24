import { useEffect, useState } from "react";
import {
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder,
  FolderX,
} from "lucide-react";
import { Button, Loading } from "./ui";
import {
  formatBytes,
  logPublicFolderOpened,
  openPublicFolder,
  openPublicFolderFile,
} from "./drive";
import type { PublicFolderView } from "./types";

/**
 * Public folder page (/pasta/<token>): works without signing in. Browses the
 * shared folder and its subfolders; files open or download through short
 * signed links, asked for on each click.
 */
export function PublicFolder({ token }: { token: string }) {
  const [view, setView] = useState<PublicFolderView | null>(null);
  const [folder, setFolder] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    void logPublicFolderOpened(token).catch(() => {});
  }, [token]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    openPublicFolder(token, folder)
      .then((v) => {
        if (!alive) return;
        if (!v) throw Error("unavailable");
        setView(v);
        document.title = `${v.path.at(-1)?.name ?? v.root.name} — Workspace`;
      })
      // Whatever went wrong, a visitor only needs to know the link doesn't
      // open (details stay out of a public page).
      .catch(() => alive && setError("Link inválido ou pasta indisponível."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [token, folder]);

  async function open(file: string, inline: boolean) {
    const tab = inline ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    setBusy(file + (inline ? ":view" : ":get"));
    try {
      const { url } = await openPublicFolderFile(token, file, inline);
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="public-file-page public-folder-page">
      <div className="public-file-card public-folder-card">
        <span className="brand">
          <span className="brand-mark">W</span>
          <span>
            workspace<span className="brand-period">.</span>
          </span>
        </span>
        {error && !view ? (
          <div className="public-file-error">
            <FolderX size={30} />
            <h1>Pasta indisponível</h1>
            <p>
              {error} O link pode ter sido desativado por quem o compartilhou.
            </p>
          </div>
        ) : !view ? (
          <Loading compact />
        ) : (
          <>
            <small>PASTA COMPARTILHADA</small>
            <nav className="public-folder-path" aria-label="Pasta atual">
              {view.path.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && <ChevronRight size={14} aria-hidden="true" />}
                  {i < view.path.length - 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setFolder(p.id === view.root.id ? undefined : p.id)
                      }
                    >
                      {p.name}
                    </button>
                  ) : (
                    <h1 aria-current="page">{p.name}</h1>
                  )}
                </span>
              ))}
            </nav>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {loading ? (
              <Loading compact />
            ) : !view.folders.length && !view.files.length ? (
              <p className="public-folder-empty">Esta pasta está vazia.</p>
            ) : (
              <ul className="public-folder-list">
                {view.folders.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      className="public-folder-item"
                      onClick={() => {
                        setError("");
                        setFolder(f.id);
                      }}
                    >
                      <Folder
                        size={18}
                        fill="currentColor"
                        fillOpacity={0.18}
                        aria-hidden="true"
                      />
                      <strong>{f.name}</strong>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
                {view.files.map((f) => (
                  <li key={f.id} className="public-folder-file">
                    <FileText size={18} aria-hidden="true" />
                    <span>
                      <strong>{f.name}</strong>
                      <small>{formatBytes(f.size_bytes)}</small>
                    </span>
                    <Button
                      className="icon-btn"
                      aria-label={`Visualizar ${f.name}`}
                      title="Visualizar"
                      loading={busy === f.id + ":view"}
                      onClick={() => void open(f.id, true)}
                    >
                      <Eye size={17} />
                    </Button>
                    <Button
                      className="icon-btn"
                      aria-label={`Baixar ${f.name}`}
                      title="Baixar"
                      loading={busy === f.id + ":get"}
                      onClick={() => void open(f.id, false)}
                    >
                      <Download size={17} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
