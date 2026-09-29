import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  CircleCheck,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder,
  FolderX,
  Upload,
} from "lucide-react";
import { Button, Loading } from "./ui";
import {
  formatBytes,
  logPublicFolderOpened,
  openPublicFolder,
  openPublicFolderFile,
  uploadToPublicFolder,
} from "./drive";
import type { PublicFolderView } from "./types";
import "./social-leads-onboarding.css";

/**
 * Public folder page (/pasta/<token>): works without signing in. Browses the
 * shared folder and its subfolders; files open or download through short
 * signed links, asked for on each click. When the link accepts uploads
 * (e.g. the social proof folder of a Social Leads client), whoever has it
 * sends images, videos, audio or PDFs into the shared folder.
 */
export function PublicFolder({ token }: { token: string }) {
  const [view, setView] = useState<PublicFolderView | null>(null);
  const [folder, setFolder] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
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
  }, [token, folder, reload]);

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
            {view.upload && view.folder === view.root.id && (
              <PublicUpload
                token={token}
                company={view.company}
                onSent={() => setReload((n) => n + 1)}
              />
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

/** Sending files through the link: drop or pick, one progress bar each. */
function PublicUpload({
  token,
  company,
  onSent,
}: {
  token: string;
  company?: string;
  onSent: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [items, setItems] = useState<
    { key: string; name: string; progress: number; error?: string }[]
  >([]);
  const [sent, setSent] = useState(0);
  const send = async (files: File[]) => {
    for (const file of files) {
      const key = `${Date.now()}-${file.name}`;
      setItems((l) => [...l, { key, name: file.name, progress: 0 }]);
      try {
        await uploadToPublicFolder(token, file, (progress) =>
          setItems((l) =>
            l.map((x) => (x.key === key ? { ...x, progress } : x)),
          ),
        );
        setItems((l) => l.filter((x) => x.key !== key));
        setSent((n) => n + 1);
        onSent();
      } catch (e) {
        setItems((l) =>
          l.map((x) =>
            x.key === key ? { ...x, error: (e as Error).message } : x,
          ),
        );
      }
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) void send([...e.dataTransfer.files]);
  };
  return (
    <div className="public-upload">
      <p>
        {company ? `${company} pediu seus arquivos aqui. ` : ""}Envie fotos,
        vídeos, áudios ou PDFs (até 500 MB cada). Depoimentos de clientes,
        bastidores e resultados reais ajudam muito.
      </p>
      <button
        type="button"
        className={`public-upload-drop${over ? " over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <Upload size={22} aria-hidden="true" />
        <strong>Enviar arquivos</strong>
        <small>Toque para escolher ou arraste para cá</small>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept="image/*,video/*,audio/*,application/pdf"
        onChange={(e) => {
          if (e.target.files?.length) void send([...e.target.files]);
          e.target.value = "";
        }}
      />
      {items.map((x) => (
        <div key={x.key} className="public-upload-item" role="status">
          <span>{x.name}</span>
          {x.error ? (
            <small className="form-error">{x.error}</small>
          ) : (
            <span className="public-upload-bar" aria-hidden="true">
              <i style={{ width: `${Math.round(x.progress * 100)}%` }} />
            </span>
          )}
        </div>
      ))}
      {sent > 0 && !items.length && (
        <p className="public-upload-done" role="status">
          <CircleCheck size={16} /> {sent}{" "}
          {sent === 1 ? "arquivo enviado" : "arquivos enviados"}. Obrigado!
        </p>
      )}
    </div>
  );
}
