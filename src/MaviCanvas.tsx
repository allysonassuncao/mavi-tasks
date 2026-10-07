import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FileText,
  HardDriveUpload,
  LayoutTemplate,
  Loader2,
  Palette,
  Pencil,
  Presentation,
  Printer,
  X,
} from "lucide-react";
import { formatValue } from "./dashboards";
import { ShadowHtml } from "./ShadowHtml";
import { DriveSaveDialog, type SaveFormat } from "./DriveSaveDialog";
import type { DriveLocation } from "./types";
import type { ArtifactHost } from "./MaviArtifacts";
import { imageLink } from "./MaviArtifacts";
import {
  clean,
  documentDocx,
  fileName,
  printHtml,
  saveBlob,
  sheetCsv,
  sheetXlsx,
  slidesPptx,
  imagesPptx,
  type ExportImage,
} from "./mavi-export";
import { CANVAS_CSS, canvasPage, documentHtml, slideHtml, type HtmlOptions } from "./mavi-doc-html";
import { canvasPages, canvasPdf, dataUrl, saveIdentity, useLookAssets } from "./identities";
import { DESIGN_FORMATS, designPage, designTokens, type DesignFormat } from "./mavi-design";
import { builtinLook, legacyLook, logoFor, lookFiles, sanitizeTokens, type Look } from "./visual-identity";
import type {
  Canvas,
  CanvasArtifact,
  ImageArtifact,
  SheetTab,
} from "./mavi-artifacts";

/**
 * O canvas da MAVI (como os artefatos da Claude e o canvas do ChatGPT): o
 * documento, a apresentação ou a planilha abre ao lado da conversa, para
 * ler, navegar, pedir ajustes e baixar em Word, PowerPoint, Excel, PDF ou
 * HTML. Documentos e apresentações saem com a identidade visual escolhida
 * (mavi-doc-html: o mesmo desenho na tela, no .html e no PDF).
 */

const KIND = {
  document: { icon: FileText, label: "Documento" },
  slides: { icon: Presentation, label: "Apresentação" },
  sheet: { icon: FileSpreadsheet, label: "Planilha" },
  design: { icon: LayoutTemplate, label: "Design" },
};
function meta(c: Canvas) {
  if (c.kind === "document") {
    const words = clean(c.markdown).split(/\s+/).filter(Boolean).length;
    return `${words.toLocaleString("pt-BR")} palavras`;
  }
  if (c.kind === "slides") return `${c.slides.length} ${c.slides.length === 1 ? "slide" : "slides"}`;
  if (c.kind === "design") return `${c.pages} ${c.pages === 1 ? "página" : "páginas"} · ${DESIGN_FORMATS[c.format].label}`;
  const rows = c.sheets.reduce((n, s) => n + s.rows.length, 0);
  return `${c.sheets.length} ${c.sheets.length === 1 ? "aba" : "abas"} · ${rows.toLocaleString("pt-BR")} linhas`;
}
const DOC_LOOK = builtinLook("claro")!;
/** O aviso das fontes que o Word e o PowerPoint não levam junto. */
const fontNote = (families: string[]) =>
  families.length === 1
    ? `No Word e no PowerPoint, a fonte ${families[0]} aparece se estiver instalada no computador; o PDF e o .html já saem com ela.`
    : `No Word e no PowerPoint, as fontes ${families.join(" e ")} aparecem se estiverem instaladas no computador; o PDF e o .html já saem com elas.`;
/** O tema do documento (o antigo das apresentações, ou o claro). */
export function lookOf(c: Canvas): Look | null {
  if (c.kind === "sheet") return null;
  // O design livre traz o próprio CSS: sem identidade, nada por cima.
  if (c.kind === "design") return c.look ?? null;
  return c.look ?? (c.kind === "slides" ? legacyLook(c.theme) : DOC_LOOK);
}

/** O card na conversa: abre no canvas. */
export function CanvasCard({ artifact, onOpen }: { artifact: CanvasArtifact; onOpen: () => void }) {
  const c = artifact.canvas;
  const Icon = KIND[c.kind].icon;
  const look = c.kind !== "sheet" ? c.look : undefined;
  return (
    <button type="button" className="mavi-card canvas-card" onClick={onOpen}>
      <span
        className="canvas-card-icon"
        aria-hidden="true"
        style={look ? { background: look.colors.primary, color: look.colors.on_primary } : undefined}
      >
        <Icon size={20} />
      </span>
      <span className="canvas-card-body">
        <strong>{c.title}</strong>
        <small>
          {KIND[c.kind].label} · {meta(c)}
          {look ? ` · ${look.name}` : ""}
          {artifact.revision_of ? ` · ajuste de ${artifact.revision_of}` : ""}
        </small>
      </span>
      <span className="canvas-card-open">Abrir</span>
    </button>
  );
}


/** As imagens da conversa que os slides usam (ref → link assinado). */
function useImageLinks(company: string, images: Map<string, ImageArtifact>, refs: string[]) {
  const key = refs.join(",");
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(
      refs.map(async (r) => {
        const img = images.get(r);
        return [r, img ? await imageLink(company, img).catch(() => null) : null] as const;
      }),
    ).then((pairs) => {
      if (live) setUrls(Object.fromEntries(pairs.filter((p): p is readonly [string, string] => !!p[1])));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, key, images]);
  return urls;
}

/** Uma imagem em PNG (o SVG vira PNG) com o tamanho, para Word e PowerPoint. */
async function exportImage(url: string): Promise<ExportImage | null> {
  const data = await dataUrl(url);
  const img = new Image();
  img.src = data;
  await img.decode();
  const width = img.naturalWidth || 600;
  const height = img.naturalHeight || 200;
  if (!/^data:image\/svg/.test(data)) return { data, width, height };
  const k = Math.max(1, 900 / width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * k);
  canvas.height = Math.round(height * k);
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { data: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}
/** A capa em degradê do PowerPoint, como imagem. */
function gradientImage(from: string, to: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 1280, 720);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1280, 720);
  return canvas.toDataURL("image/png");
}

const SCREEN_CSS = {
  document: `${CANVAS_CSS.document}.doc{max-width:820px;margin:0 auto;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px #1c272814;border:1px solid #0000000f}`,
  slides: `${CANVAS_CSS.slides}.s{border-radius:10px;box-shadow:0 10px 30px #1c272814;border:1px solid #0000000f}`,
  thumb: `${CANVAS_CSS.slides}.s{border-radius:4px}`,
};

/** Um pedido de salvar no Drive (do cartão da MAVI): abre a janela já pronta. */
export type CanvasSaveRequest = { format: string; start: DriveLocation; name: string; onSaved: (file: string) => void };

export function CanvasPanel({
  artifact,
  host,
  images,
  onClose,
  saveRequest,
}: {
  artifact: CanvasArtifact;
  host: ArtifactHost;
  saveRequest?: CanvasSaveRequest | null;
  /** As imagens desta conversa (para os slides). */
  images: Map<string, ImageArtifact>;
  onClose: () => void;
}) {
  const c = artifact.canvas;
  const Icon = KIND[c.kind].icon;
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const look = useMemo(() => lookOf(c), [c]);
  const design = useMemo(() => (c.kind === "design" ? designTokens(c.html) : null), [c]);
  const fileUrls = useLookAssets(host.company, look, design?.files ?? []);
  const refs = useMemo(
    () =>
      c.kind === "slides"
        ? [...new Set(c.slides.map((s) => s.image).filter((r): r is string => !!r))]
        : (design?.images ?? []),
    [c, design],
  );
  const imageUrls = useImageLinks(host.company, images, refs);
  const screen: HtmlOptions = useMemo(
    () => ({
      url: (token) =>
        token.startsWith("file:") ? (fileUrls[token.slice(5)] ?? null) : (imageUrls[token.slice(4)] ?? null),
    }),
    [fileUrls, imageUrls],
  );
  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
    } catch (e) {
      host.notify((e as Error)?.message && label.startsWith("PDF") ? (e as Error).message : "Não foi possível gerar o arquivo.");
    } finally {
      setBusy("");
    }
  }
  const imageData = async (ref: string) => {
    const url = imageUrls[ref] ?? (images.get(ref) ? await imageLink(host.company, images.get(ref)!) : null);
    return url ? dataUrl(url) : null;
  };
  const assets = {
    logo: async (bg: string) => {
      const id = look ? logoFor(look, bg) : null;
      const url = id ? fileUrls[id] : null;
      return url ? exportImage(url) : null;
    },
    gradient: gradientImage,
  };
  type Paged = Extract<Canvas, { kind: "document" | "slides" | "design" }>;
  /** A página inteira (o que vai para o PDF e o .html). */
  const pageOf = (doc: Paged, lk: Look | null, url?: (t: string) => string | null) =>
    doc.kind === "design" ? designPage(doc.html, doc.format, lk, url) : canvasPage(doc, lk ?? DOC_LOOK, { url });
  const filesOf = (lk: Look | null) => [...new Set([...(lk ? lookFiles(lk) : []), ...(design?.files ?? [])])];
  /** A página com tudo dentro (logos, fontes e imagens em data:). */
  async function selfContained(doc: Paged, lk: Look | null) {
    const tokens: [string, string | undefined][] = [
      ...filesOf(lk).map((id): [string, string | undefined] => [`file:${id}`, fileUrls[id]]),
      ...refs.map((r): [string, string | undefined] => [`img:${r}`, imageUrls[r]]),
    ];
    const data = new Map<string, string>(
      await Promise.all(
        tokens.filter((t): t is [string, string] => !!t[1]).map(async ([t, u]): Promise<[string, string]> => [t, await dataUrl(u).catch(() => "")]),
      ),
    );
    return pageOf(doc, lk, (t) => data.get(t) || null);
  }
  const imagePaths = () =>
    Object.fromEntries(refs.map((r) => [r, images.get(r)?.path]).filter((p): p is [string, string] => !!p[1]));
  async function pdf(doc: Paged, lk: Look | null) {
    const url = await canvasPdf(host.company, pageOf(doc, lk), filesOf(lk), imagePaths());
    return (await fetch(url)).blob();
  }
  /** O design livre no PowerPoint: cada página como imagem. */
  async function designPptx(doc: Extract<Canvas, { kind: "design" }>, lk: Look | null) {
    const r = await canvasPages(host.company, pageOf(doc, lk), filesOf(lk), imagePaths(), doc.format);
    const pics = await Promise.all(r.urls.map((u) => dataUrl(u)));
    return imagesPptx(doc.title, pics, r.width, r.height);
  }
  const html = async (doc: Paged, lk: Look | null) => new Blob([await selfContained(doc, lk)], { type: "text/html" });
  // Os formatos de cada tipo: o mesmo arquivo serve para baixar e para o Drive.
  const formats: SaveFormat[] =
    c.kind === "document" && look
      ? [
          { key: "pdf", label: "PDF", ext: "pdf", make: () => pdf(c, look) },
          { key: "docx", label: "Word (.docx)", ext: "docx", make: () => documentDocx(c.title, c.markdown, look, assets) },
          { key: "html", label: "Página (.html)", ext: "html", make: () => html(c, look) },
          {
            key: "md",
            label: "Markdown (.md)",
            ext: "md",
            make: async () => new Blob([`# ${c.title}\n\n${clean(c.markdown)}\n`], { type: "text/markdown" }),
          },
        ]
      : c.kind === "slides" && look
        ? [
            { key: "pdf", label: "PDF", ext: "pdf", make: () => pdf(c, look) },
            { key: "pptx", label: "PowerPoint (.pptx)", ext: "pptx", make: () => slidesPptx(c, imageData, assets) },
            { key: "html", label: "Página (.html)", ext: "html", make: () => html(c, look) },
          ]
        : c.kind === "design"
          ? [
              { key: "pdf", label: "PDF", ext: "pdf", make: () => pdf(c, look) },
              { key: "html", label: "Página (.html)", ext: "html", make: () => html(c, look) },
              ...(c.format === "slides" || c.format === "square"
                ? [{ key: "pptx", label: "PowerPoint (páginas como imagem)", ext: "pptx", make: () => designPptx(c, look) }]
                : []),
            ]
          : c.kind === "sheet"
            ? [
                { key: "xlsx", label: "Excel (.xlsx)", ext: "xlsx", make: () => sheetXlsx(c.sheets) },
                ...c.sheets.map((t, i) => ({
                  key: `csv-${i}`,
                  label: `CSV · ${t.name}`,
                  ext: "csv",
                  make: async () => new Blob([sheetCsv(t)], { type: "text/csv" }),
                })),
              ]
            : [];
  const exports = formats.map((f) => ({
    label: f.label,
    run: async () => saveBlob(fileName(f.key.startsWith("csv-") ? `${c.title}-${f.label.slice(6)}` : c.title, f.ext), await f.make()),
  }));
  const [saving, setSaving] = useState(!!saveRequest);
  function print() {
    const node = body.current?.querySelector(".canvas-printable");
    if (node && !printHtml(c.title, node.outerHTML)) host.notify("O navegador bloqueou a janela de impressão.");
  }
  async function saveLook() {
    if (!look) return;
    await run("Salvar", async () => {
      await saveIdentity(host.company, {
        id: null,
        scope: "gallery",
        client: null,
        name: look.name.slice(0, 80),
        description: `Sugerido pela MAVI em “${c.title}”.`.slice(0, 300),
        tokens: sanitizeTokens(look),
        guide: "",
        reason: "Salvo de um documento da MAVI",
      });
      setSaved(true);
      host.notify(`“${look.name}” está na galeria (MAVI › Identidades).`);
    });
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
        {look && (
          <span className="canvas-look" title={`Identidade visual: ${look.name}`}>
            <span className="canvas-look-swatch" aria-hidden="true">
              <i style={{ background: look.colors.bg }} />
              <i style={{ background: look.colors.primary }} />
              <i style={{ background: look.colors.accent }} />
            </span>
            <span className="canvas-look-name">{look.name}</span>
          </span>
        )}
        {look?.source === "custom" && !host.readOnly && !saved && (
          <button type="button" className="icon-btn" title="Salvar este estilo na galeria" aria-label="Salvar este estilo na galeria" disabled={!!busy} onClick={() => void saveLook()}>
            <BookmarkPlus size={16} />
          </button>
        )}
        {!host.readOnly && (
          <button
            type="button"
            className="icon-btn"
            title={look ? "Pedir um ajuste à MAVI (texto ou visual)" : "Pedir um ajuste à MAVI"}
            aria-label="Pedir um ajuste à MAVI"
            onClick={() => host.onDraft(`Ajuste o ${artifact.ref}: `)}
          >
            <Pencil size={16} />
          </button>
        )}
        {!host.readOnly && look && (
          <button
            type="button"
            className="icon-btn"
            title="Trocar a identidade visual"
            aria-label="Trocar a identidade visual"
            onClick={() => host.onDraft(`Refaça o ${artifact.ref} com outra identidade visual: `)}
          >
            <Palette size={16} />
          </button>
        )}
        {c.kind === "sheet" && (
          <button type="button" className="icon-btn" title="Imprimir ou salvar em PDF" aria-label="Imprimir ou salvar em PDF" onClick={print}>
            <Printer size={16} />
          </button>
        )}
        {host.drive && !host.readOnly && formats.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            title="Salvar no Drive"
            aria-label="Salvar no Drive"
            disabled={!!busy}
            onClick={() => setSaving(true)}
          >
            <HardDriveUpload size={16} />
          </button>
        )}
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="btn secondary canvas-download" disabled={!!busy}>
              {busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} {busy === "PDF" ? "Gerando o PDF…" : "Baixar"}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="status-menu canvas-menu" align="end" sideOffset={6}>
              {exports.map((e) => (
                <button key={e.label} type="button" onClick={() => void run(e.label, e.run)}>
                  {e.label}
                </button>
              ))}
              {look && c.kind !== "design" && (look.heading.source !== "system" || look.body.source !== "system") && (
                <p className="canvas-menu-note">
                  {fontNote([...new Set([look.heading, look.body].filter((f) => f.source !== "system").map((f) => f.family))])}
                </p>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <button type="button" className="icon-btn" aria-label="Fechar o canvas" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      {saving && host.drive && (
        <DriveSaveDialog
          company={host.company}
          data={host.drive.data}
          user={host.drive.user}
          isLeader={host.drive.isLeader}
          start={saveRequest?.start ?? host.drive.start ?? (look?.client ? { client: look.client } : {})}
          title={saveRequest?.name ?? c.title}
          initialFormat={saveRequest?.format === "csv" ? "csv-0" : saveRequest?.format}
          formats={formats}
          onClose={() => setSaving(false)}
          onSaved={(file, where) => {
            setSaving(false);
            saveRequest?.onSaved(file);
            host.notify(`Salvo no Drive, em “${where}”.`);
          }}
        />
      )}
      <div className="canvas-body" ref={body}>
        {c.kind === "document" && look ? (
          <ShadowHtml css={SCREEN_CSS.document} html={documentHtml(c.title, c.markdown, look, screen)} />
        ) : c.kind === "slides" && look ? (
          <SlidesView canvas={c} look={look} options={screen} />
        ) : c.kind === "design" ? (
          <DesignView page={designPage(c.html, c.format, look, screen.url)} format={c.format} title={c.title} />
        ) : c.kind === "sheet" ? (
          <SheetView sheets={c.sheets} />
        ) : null}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------ design livre
/**
 * As páginas do design livre num iframe sem scripts (sandbox só com a mesma
 * origem, para medir a altura), na largura do painel.
 */
function DesignView({ page, format, title }: { page: string; format: DesignFormat; title: string }) {
  const f = DESIGN_FORMATS[format];
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(f.height + 32);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  function measure() {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const fit = () => setHeight(Math.max(f.height, doc.documentElement.scrollHeight));
    fit();
    void doc.fonts?.ready.then(fit);
  }
  const frameWidth = f.width + 32;
  const scale = width ? Math.min(1, width / frameWidth) : 1;
  return (
    <div className="canvas-design" ref={box}>
      <div style={{ height: height * scale, width: frameWidth * scale, margin: "0 auto" }}>
        <iframe
          ref={frame}
          title={title}
          sandbox="allow-same-origin"
          srcDoc={page}
          onLoad={measure}
          style={{ width: frameWidth, height, transform: `scale(${scale})`, transformOrigin: "0 0", border: 0, display: "block" }}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ apresentação
function SlidesView({
  canvas,
  look,
  options,
}: {
  canvas: Extract<Canvas, { kind: "slides" }>;
  look: Look;
  options: HtmlOptions;
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
  const html = useMemo(() => canvas.slides.map((s, k) => slideHtml(s, look, k, options)), [canvas, look, options]);
  const slide = canvas.slides[i];
  return (
    <div className="canvas-slides">
      <div className="canvas-stage" ref={stage} tabIndex={0} aria-label={`Slide ${i + 1} de ${n}`}>
        <ShadowHtml css={SCREEN_CSS.slides} html={html[i]} />
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
                <ShadowHtml css={SCREEN_CSS.thumb} html={html[k]} />
              </span>
              <small>{k + 1}</small>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
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
