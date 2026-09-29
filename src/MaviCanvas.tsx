import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Pencil,
  Presentation,
  Printer,
  X,
} from "lucide-react";
import { MaviMarkdown } from "./MaviMarkdown";
import { formatValue } from "./dashboards";
import type { ArtifactHost } from "./MaviArtifacts";
import { imageLink, useImageUrl } from "./MaviArtifacts";
import {
  THEMES,
  clean,
  documentDocx,
  fileName,
  printHtml,
  runs,
  saveBlob,
  sheetCsv,
  sheetXlsx,
  slidesPptx,
} from "./mavi-export";
import type {
  Canvas,
  CanvasArtifact,
  ImageArtifact,
  SheetTab,
  Slide,
  SlideTheme,
} from "./mavi-artifacts";

/**
 * O canvas da MAVI (como os artefatos da Claude e o canvas do ChatGPT): o
 * documento, a apresentação ou a planilha abre ao lado da conversa, para
 * ler, navegar, pedir ajustes e baixar em Word, PowerPoint, Excel ou PDF.
 */

const KIND = {
  document: { icon: FileText, label: "Documento" },
  slides: { icon: Presentation, label: "Apresentação" },
  sheet: { icon: FileSpreadsheet, label: "Planilha" },
};
function meta(c: Canvas) {
  if (c.kind === "document") {
    const words = clean(c.markdown).split(/\s+/).filter(Boolean).length;
    return `${words.toLocaleString("pt-BR")} palavras`;
  }
  if (c.kind === "slides") return `${c.slides.length} ${c.slides.length === 1 ? "slide" : "slides"}`;
  const rows = c.sheets.reduce((n, s) => n + s.rows.length, 0);
  return `${c.sheets.length} ${c.sheets.length === 1 ? "aba" : "abas"} · ${rows.toLocaleString("pt-BR")} linhas`;
}

/** O card na conversa: abre no canvas. */
export function CanvasCard({ artifact, onOpen }: { artifact: CanvasArtifact; onOpen: () => void }) {
  const c = artifact.canvas;
  const Icon = KIND[c.kind].icon;
  return (
    <button type="button" className="mavi-card canvas-card" onClick={onOpen}>
      <span className="canvas-card-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <span className="canvas-card-body">
        <strong>{c.title}</strong>
        <small>
          {KIND[c.kind].label} · {meta(c)}
          {artifact.revision_of ? ` · ajuste de ${artifact.revision_of}` : ""}
        </small>
      </span>
      <span className="canvas-card-open">Abrir</span>
    </button>
  );
}

/** Negrito e itálico, sem as marcas da conversa (fontes, anexos). */
const inline = (t: string): ReactNode[] =>
  runs(t).map((r, i) =>
    r.bold ? <strong key={i}>{r.text}</strong> : r.italics ? <em key={i}>{r.text}</em> : <span key={i}>{r.text}</span>,
  );

export function CanvasPanel({
  artifact,
  host,
  images,
  onClose,
}: {
  artifact: CanvasArtifact;
  host: ArtifactHost;
  /** As imagens desta conversa (para os slides). */
  images: Map<string, ImageArtifact>;
  onClose: () => void;
}) {
  const c = artifact.canvas;
  const Icon = KIND[c.kind].icon;
  const [busy, setBusy] = useState("");
  const body = useRef<HTMLDivElement>(null);
  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
    } catch {
      host.notify("Não foi possível gerar o arquivo.");
    } finally {
      setBusy("");
    }
  }
  const imageData = async (ref: string) => {
    const img = images.get(ref);
    if (!img) return null;
    const url = await imageLink(host.company, img);
    if (!url) return null;
    const blob = await (await fetch(url)).blob();
    return await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(blob);
    });
  };
  const exports: { label: string; run: () => Promise<void> }[] =
    c.kind === "document"
      ? [
          { label: "Word (.docx)", run: async () => saveBlob(fileName(c.title, "docx"), await documentDocx(c.title, c.markdown)) },
          {
            label: "Markdown (.md)",
            run: async () =>
              saveBlob(fileName(c.title, "md"), new Blob([`# ${c.title}\n\n${clean(c.markdown)}\n`], { type: "text/markdown" })),
          },
        ]
      : c.kind === "slides"
        ? [{ label: "PowerPoint (.pptx)", run: async () => saveBlob(fileName(c.title, "pptx"), await slidesPptx(c, imageData)) }]
        : [
            { label: "Excel (.xlsx)", run: async () => saveBlob(fileName(c.title, "xlsx"), await sheetXlsx(c.sheets)) },
            ...c.sheets.map((t) => ({
              label: `CSV · ${t.name}`,
              run: async () => saveBlob(fileName(`${c.title}-${t.name}`, "csv"), new Blob([sheetCsv(t)], { type: "text/csv" })),
            })),
          ];
  function print() {
    const node = body.current?.querySelector(".canvas-printable");
    if (!node) return;
    // A apresentação imprime todos os slides, um por página.
    const html =
      c.kind === "slides"
        ? [...(body.current?.querySelectorAll(".canvas-all .canvas-slide-box") ?? [])].map((n) => n.outerHTML).join("")
        : node.outerHTML;
    if (!printHtml(c.title, html, c.kind === "slides"))
      host.notify("O navegador bloqueou a janela de impressão.");
  }
  return (
    <aside className="canvas-pane" aria-label={`${KIND[c.kind].label}: ${c.title}`}>
      <header className="canvas-head">
        <span className="canvas-card-icon small" aria-hidden="true">
          <Icon size={16} />
        </span>
        <span className="canvas-head-title">
          <strong title={c.title}>{c.title}</strong>
          <small>
            {artifact.ref} · {KIND[c.kind].label} · {meta(c)}
            {artifact.revision_of ? ` · ajuste de ${artifact.revision_of}` : ""}
          </small>
        </span>
        {!host.readOnly && (
          <button
            type="button"
            className="icon-btn"
            title="Pedir um ajuste à MAVI"
            aria-label="Pedir um ajuste à MAVI"
            onClick={() => host.onDraft(`Ajuste o ${artifact.ref}: `)}
          >
            <Pencil size={16} />
          </button>
        )}
        <button type="button" className="icon-btn" title="Imprimir ou salvar em PDF" aria-label="Imprimir ou salvar em PDF" onClick={print}>
          <Printer size={16} />
        </button>
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="btn secondary canvas-download" disabled={!!busy}>
              {busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} Baixar
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="status-menu canvas-menu" align="end" sideOffset={6}>
              {exports.map((e) => (
                <button key={e.label} type="button" onClick={() => void run(e.label, e.run)}>
                  {e.label}
                </button>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <button type="button" className="icon-btn" aria-label="Fechar o canvas" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="canvas-body" ref={body}>
        {c.kind === "document" ? (
          <article className="canvas-doc canvas-printable">
            <h1>{c.title}</h1>
            <MaviMarkdown text={c.markdown} inline={inline} />
          </article>
        ) : c.kind === "slides" ? (
          <SlidesView canvas={c} company={host.company} images={images} />
        ) : (
          <SheetView sheets={c.sheets} />
        )}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------ apresentação
function SlidesView({
  canvas,
  company,
  images,
}: {
  canvas: Extract<Canvas, { kind: "slides" }>;
  company: string;
  images: Map<string, ImageArtifact>;
}) {
  const [at, setAt] = useState(0);
  const n = canvas.slides.length;
  const i = Math.min(at, n - 1);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setAt((x) => Math.min(n - 1, x + 1));
      if (e.key === "ArrowLeft") setAt((x) => Math.max(0, x - 1));
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [n]);
  const slide = canvas.slides[i];
  return (
    <div className="canvas-slides">
      <div className="canvas-stage canvas-printable" ref={stage} tabIndex={0} aria-label={`Slide ${i + 1} de ${n}`}>
        <SlideView slide={slide} theme={canvas.theme} company={company} images={images} />
      </div>
      <div className="canvas-nav">
        <button type="button" className="icon-btn" aria-label="Slide anterior" disabled={i === 0} onClick={() => setAt(i - 1)}>
          <ChevronLeft size={18} />
        </button>
        <span>
          {i + 1} / {n}
        </span>
        <button type="button" className="icon-btn" aria-label="Próximo slide" disabled={i === n - 1} onClick={() => setAt(i + 1)}>
          <ChevronRight size={18} />
        </button>
      </div>
      {slide.notes && (
        <p className="canvas-notes">
          <strong>Notas:</strong> {clean(slide.notes)}
        </p>
      )}
      <ol className="canvas-thumbs" aria-label="Slides">
        {canvas.slides.map((s, k) => (
          <li key={k}>
            <button type="button" className={k === i ? "current" : ""} onClick={() => setAt(k)} aria-label={`Slide ${k + 1}: ${s.title}`}>
              <span className="canvas-thumb-frame">
                <SlideView slide={s} theme={canvas.theme} company={company} images={images} />
              </span>
              <small>{k + 1}</small>
            </button>
          </li>
        ))}
      </ol>
      {/* Para imprimir: todos os slides, um por página. */}
      <div className="canvas-all" hidden>
        {canvas.slides.map((s, k) => (
          <SlideView key={k} slide={s} theme={canvas.theme} company={company} images={images} />
        ))}
      </div>
    </div>
  );
}

function SlideView({
  slide: s,
  theme,
  company,
  images,
}: {
  slide: Slide;
  theme: SlideTheme;
  company: string;
  images: Map<string, ImageArtifact>;
}) {
  const t = THEMES[theme];
  const style = {
    "--slide-bg": `#${t.bg}`,
    "--slide-ink": `#${t.ink}`,
    "--slide-muted": `#${t.muted}`,
    "--slide-accent": `#${t.accent}`,
    "--slide-soft": `#${t.soft}`,
  } as CSSProperties;
  const list = (items?: string[]) =>
    items?.length ? (
      <ul>
        {items.map((b, k) => (
          <li key={k}>{inline(b)}</li>
        ))}
      </ul>
    ) : null;
  // A moldura é a referência do tamanho (as letras acompanham a largura).
  return (
    <div className="canvas-slide-box">
    <div className={`canvas-slide layout-${s.layout}`} style={style}>
      {s.layout === "title" || s.layout === "closing" ? (
        <div className="slide-center">
          <h2>{inline(s.title)}</h2>
          {s.subtitle && <p>{inline(s.subtitle)}</p>}
        </div>
      ) : s.layout === "section" ? (
        <div className="slide-section">
          <h2>{inline(s.title)}</h2>
          {s.subtitle && <p>{inline(s.subtitle)}</p>}
        </div>
      ) : s.layout === "quote" ? (
        <figure className="slide-quote">
          <blockquote>“{inline(s.quote ?? s.title)}”</blockquote>
          {s.author && <figcaption>— {s.author}</figcaption>}
        </figure>
      ) : (
        <>
          <h3>{inline(s.title)}</h3>
          {s.subtitle && s.layout !== "stats" && <p className="slide-sub">{inline(s.subtitle)}</p>}
          {s.layout === "two_columns" ? (
            <div className="slide-cols">
              <div>
                {s.left_title && <h4>{s.left_title}</h4>}
                {list(s.left)}
              </div>
              <div>
                {s.right_title && <h4>{s.right_title}</h4>}
                {list(s.right)}
              </div>
            </div>
          ) : s.layout === "stats" ? (
            <>
              <div className="slide-stats">
                {s.stats?.map((st, k) => (
                  <div key={k}>
                    <strong>{st.value}</strong>
                    <span>{st.label}</span>
                  </div>
                ))}
              </div>
              {s.subtitle && <p className="slide-sub">{inline(s.subtitle)}</p>}
            </>
          ) : s.layout === "image" ? (
            <div className={`slide-image${s.bullets?.length ? " with-text" : ""}`}>
              {s.image && images.get(s.image) ? (
                <SlideImage company={company} image={images.get(s.image)!} />
              ) : (
                <span className="slide-image-empty">Imagem {s.image ?? ""}</span>
              )}
              {list(s.bullets)}
            </div>
          ) : (
            list(s.bullets)
          )}
        </>
      )}
    </div>
    </div>
  );
}
function SlideImage({ company, image }: { company: string; image: ImageArtifact }) {
  const { url } = useImageUrl(company, image);
  return url ? <img src={url} alt={image.prompt} /> : <span className="slide-image-empty" />;
}

// ------------------------------------------------------------ planilha
function SheetView({ sheets }: { sheets: SheetTab[] }) {
  const [tab, setTab] = useState(0);
  const t = sheets[Math.min(tab, sheets.length - 1)];
  const cell = useMemo(
    () => (v: string | number | null, unit?: string) =>
      v === null
        ? ""
        : typeof v === "number"
          ? unit === "money"
            ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
            : formatValue(v, (unit && unit !== "text" ? unit : "number") as "number")
          : clean(v),
    [],
  );
  return (
    <div className="canvas-sheet canvas-printable">
      {sheets.length > 1 && (
        <div className="drive-view canvas-tabs" role="tablist">
          {sheets.map((s, k) => (
            <button key={k} type="button" role="tab" aria-selected={k === tab} className={k === tab ? "selected" : ""} onClick={() => setTab(k)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="mavi-table-wrap canvas-table">
        <table className="mavi-table">
          <thead>
            <tr>
              <th className="canvas-rownum" aria-hidden="true" />
              {t.columns.map((c, k) => (
                <th key={k} className={c.unit && c.unit !== "text" ? "num" : ""}>
                  <span className="canvas-th">{c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, ri) => (
              <tr key={ri}>
                <td className="canvas-rownum">{ri + 2}</td>
                {t.columns.map((c, k) => (
                  <td key={k} className={c.unit && c.unit !== "text" ? "num" : ""}>
                    {cell(r[k], c.unit)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
