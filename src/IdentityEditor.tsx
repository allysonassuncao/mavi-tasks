import { useEffect, useMemo, useState } from "react";
import { Download, History, Palette, RotateCcw, Sparkles, Type } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { ShadowHtml } from "./ShadowHtml";
import { CANVAS_CSS, documentHtml, slideHtml } from "./mavi-doc-html";
import { fileName, saveBlob } from "./mavi-export";
import { brandUrls, loadBrand, type Brand } from "./brand";
import {
  clientIdentity,
  getIdentity,
  identityVersion,
  restoreIdentity,
  saveIdentity,
  useLookAssets,
  type IdentityFull,
} from "./identities";
import {
  COLOR_LABELS,
  COVERS,
  COVER_LABELS,
  DECORS,
  DECOR_LABELS,
  GOOGLE_FONTS,
  SYSTEM_FONTS,
  contrastIssues,
  readableOn,
  sanitizeTokens,
  tokensFromBrand,
  type FontSource,
  type IdentityColors,
  type IdentityFont,
  type IdentityScope,
  type IdentityTokens,
  type Look,
} from "./visual-identity";
import "./identities.css";

/**
 * O editor de uma identidade visual: o tema (cores por função, fontes,
 * logos, capa, detalhe e cantos) com a prévia desenhada como nos arquivos, e
 * o Guia da marca em Markdown (o que a MAVI lê para escrever e montar).
 * Cada salvamento é uma versão; restaurar vira versão nova.
 */

export type IdentityDraft = {
  id: string | null;
  scope: IdentityScope;
  client: string | null;
  name: string;
  description: string;
  tokens: IdentityTokens;
  guide: string;
};

const GUIDE_TEMPLATE = `## Essência
O que a marca é e como quer ser percebida, em 2 ou 3 frases.

## Tom de voz
- Como fala (ex.: próximo, direto, sem jargão)
- Palavras que usa e que evita

## Visual
- Quando usar fundo escuro ou claro
- Como usar a cor principal e o destaque
- Fotos e ilustrações: estilo

## Faça
-

## Evite
-

## Exemplos aprovados
- (documentos, apresentações ou artes que o cliente aprovou)

## Aprendizados
- (correções do cliente, com a data)
`;

const SAMPLE_DOC = `## Resumo do mês
Os leads cresceram **18%** com o mesmo investimento. A campanha de remarketing foi a que mais converteu.

| Canal | Leads | Custo por lead |
|---|---|---|
| Meta | 412 | R$ 18,40 |
| Google | 200 | R$ 22,10 |

> Próximo passo: dobrar a verba do remarketing.

- Criativos novos na semana 2
- Teste de landing page`;

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900];
const fontLabel = (s: FontSource) => (s === "google" ? "Google Fonts" : s === "brand" ? "Da marca" : "Do computador");

/** Um rascunho novo (da Marca do cliente, de um estilo, ou do padrão). */
export function newDraft(scope: IdentityScope, client: string | null, from?: Partial<IdentityDraft>): IdentityDraft {
  return {
    id: null,
    scope,
    client,
    name: from?.name ?? "",
    description: from?.description ?? "",
    tokens: from?.tokens ?? sanitizeTokens({}),
    guide: from?.guide ?? (scope === "gallery" ? "" : GUIDE_TEMPLATE),
  };
}
export const draftOf = (r: IdentityFull): IdentityDraft => ({
  id: r.id,
  scope: r.scope,
  client: r.client_id,
  name: r.name,
  description: r.description,
  tokens: sanitizeTokens(r.tokens),
  guide: r.guide ?? "",
});

/** O código da cor: aceita enquanto a pessoa digita e grava quando fica válido. */
function HexInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="identity-hex"
      aria-label={`Código: ${label}`}
      value={text}
      maxLength={7}
      spellCheck={false}
      onChange={(e) => {
        const v = e.target.value.trim();
        setText(v);
        if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v);
      }}
      onBlur={() => setText(value)}
    />
  );
}

/** A prévia: capa, um slide de conteúdo e o começo de um documento. */
export function IdentityPreview({ company, look, compact = false }: { company: string; look: Look; compact?: boolean }) {
  const urls = useLookAssets(company, look);
  const opts = useMemo(() => ({ url: (t: string) => (t.startsWith("file:") ? (urls[t.slice(5)] ?? null) : null) }), [urls]);
  const cover = slideHtml({ layout: "title", title: look.name || "Sua identidade", subtitle: "Apresentação de exemplo" }, look, 0, opts);
  if (compact) return <ShadowHtml css={`${CANVAS_CSS.slides}.s{border-radius:8px}`} html={cover} />;
  const content = slideHtml(
    { layout: "stats", title: "Resultados de setembro", stats: [{ value: "612", label: "leads" }, { value: "R$ 19", label: "por lead" }, { value: "+18%", label: "no mês" }] },
    look,
    1,
    opts,
  );
  const bullets = slideHtml({ layout: "bullets", title: "Próximos passos", bullets: ["Dobrar a verba do remarketing", "Criativos novos na **semana 2**", "Teste de landing page"] }, look, 2, opts);
  return (
    <div className="identity-preview">
      <div className="identity-preview-slides">
        <ShadowHtml css={`${CANVAS_CSS.slides}.s{border-radius:8px}`} html={cover} />
        <ShadowHtml css={`${CANVAS_CSS.slides}.s{border-radius:8px}`} html={content} />
        <ShadowHtml css={`${CANVAS_CSS.slides}.s{border-radius:8px}`} html={bullets} />
      </div>
      <div className="identity-preview-doc">
        <ShadowHtml
          css={`${CANVAS_CSS.document}.doc{border-radius:10px;overflow:hidden;zoom:.6}`}
          html={documentHtml("Relatório de exemplo", SAMPLE_DOC, look, opts)}
        />
      </div>
    </div>
  );
}

export function IdentityEditor({
  company,
  initial,
  clients,
  notify,
  onSaved,
  onCancel,
}: {
  company: string;
  initial: IdentityDraft;
  /** Os clientes cuja Marca dá para usar (logos e fontes), na empresa e na galeria. */
  clients?: { id: string; name: string }[];
  notify: (message: string) => void;
  onSaved: (id: string) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [full, setFull] = useState<IdentityFull | null>(null);
  // De onde vêm os logos e as fontes: o cliente da identidade, ou um escolhido.
  const [picked, setPicked] = useState<string | null>(draft.scope === "client" ? draft.client : null);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [brandLinks, setBrandLinks] = useState<Record<string, string>>({});
  const source = draft.scope === "client" ? draft.client : picked;
  useEffect(() => {
    if (!draft.id) return;
    void getIdentity(draft.id).then(setFull).catch(() => {});
  }, [draft.id]);
  useEffect(() => {
    let live = true;
    setBrand(null);
    if (!source) return;
    void loadBrand(company, source)
      .then(async (b) => {
        if (!live) return;
        setBrand(b);
        if (b?.files.length) setBrandLinks(await brandUrls(company, source).catch(() => ({})));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [company, source]);

  const t = draft.tokens;
  const set = (next: Partial<IdentityTokens>) => setDraft((d) => ({ ...d, tokens: { ...d.tokens, ...next } }));
  const setColor = (k: keyof IdentityColors, v: string) => set({ colors: { ...t.colors, [k]: v.toUpperCase() } });
  const look: Look = useMemo(() => ({ ...draft.tokens, id: draft.id ?? "draft", name: draft.name || "Sua identidade", source: "gallery" }), [draft]);
  const issues = contrastIssues(t);
  const images = (brand?.files ?? []).filter((f) => /\.(png|jpe?g|webp|svg|gif)$/i.test(f.name));
  const brandFamilies = [...new Set((brand?.fonts ?? []).map((f) => f.family))];

  function setFont(which: "heading" | "body", next: Partial<IdentityFont>) {
    const f = { ...t[which], ...next };
    if (next.source && next.source !== t[which].source)
      f.family = next.source === "brand" ? (brandFamilies[0] ?? f.family) : next.source === "system" ? "Calibri" : "Inter";
    const fonts = { ...t, [which]: f };
    // As fontes da marca que os dois papéis usam vão junto (todos os pesos).
    const used = new Set([fonts.heading, fonts.body].filter((x) => x.source === "brand").map((x) => x.family));
    const faces = (brand?.fonts ?? [])
      .filter((x) => used.has(x.family))
      .map((x) => ({ file: x.file, family: x.family, weight: x.weight, style: x.style }));
    set({ [which]: f, faces: faces.length ? faces : t.faces.filter((x) => used.has(x.family)) } as Partial<IdentityTokens>);
  }

  async function save() {
    if (!draft.name.trim()) return setError("Dê um nome à identidade.");
    setSaving(true);
    setError("");
    try {
      const r = await saveIdentity(company, { ...draft, reason });
      setDraft((d) => ({ ...d, id: r.id }));
      setReason("");
      setFull(await getIdentity(r.id).catch(() => null));
      notify(`Identidade salva (versão ${r.version}): a MAVI já usa nos próximos documentos.`);
      onSaved(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function restore(version: number) {
    if (!draft.id) return;
    const v = await identityVersion(draft.id, version).catch(() => null);
    if (!v || !window.confirm(`Restaurar a versão ${version} (“${v.name}”)? Vira uma versão nova; nada se perde.`)) return;
    try {
      await restoreIdentity(draft.id, version);
      const r = await getIdentity(draft.id);
      if (r) {
        setDraft(draftOf(r));
        setFull(r);
      }
      notify(`Versão ${version} restaurada.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const fontFields = (which: "heading" | "body", label: string) => {
    const f = t[which];
    const families =
      f.source === "brand" ? brandFamilies : f.source === "system" ? Object.keys(SYSTEM_FONTS) : Object.keys(GOOGLE_FONTS);
    const weights = f.source === "google" && GOOGLE_FONTS[f.family] ? GOOGLE_FONTS[f.family] : WEIGHTS;
    return (
      <div className="identity-font">
        <span className="identity-label">
          <Type size={13} aria-hidden="true" /> {label}
        </span>
        <Select aria-label={`Origem da fonte: ${label}`} value={f.source} onValueChange={(v) => setFont(which, { source: v as FontSource })}>
          {(["google", "brand", "system"] as FontSource[])
            .filter((s) => s !== "brand" || brandFamilies.length || f.source === "brand")
            .map((s) => (
              <SelectOption key={s} value={s}>
                {fontLabel(s)}
              </SelectOption>
            ))}
        </Select>
        <Select aria-label={`Fonte: ${label}`} value={f.family} onValueChange={(v) => setFont(which, { family: v })}>
          {[...new Set([f.family, ...families])].map((name) => (
            <SelectOption key={name} value={name}>
              {name}
            </SelectOption>
          ))}
        </Select>
        <Select aria-label={`Peso: ${label}`} value={String(f.weight)} onValueChange={(v) => setFont(which, { weight: Number(v) })}>
          {[...new Set([f.weight, ...weights])].sort((a, b) => a - b).map((w) => (
            <SelectOption key={w} value={String(w)}>
              {w}
            </SelectOption>
          ))}
        </Select>
      </div>
    );
  };
  const logoField = (which: "light" | "dark", label: string) => (
    <label className="identity-logo">
      <span className="identity-label">{label}</span>
      <Select
        aria-label={label}
        value={t.logo[which] ?? "none"}
        onValueChange={(v) => set({ logo: { ...t.logo, [which]: v === "none" ? undefined : v } })}
      >
        <SelectOption value="none">Sem logo</SelectOption>
        {images.map((f) => (
          <SelectOption key={f.id} value={f.id}>
            {f.name}
          </SelectOption>
        ))}
        {t.logo[which] && !images.some((f) => f.id === t.logo[which]) && (
          <SelectOption value={t.logo[which]!}>Arquivo atual</SelectOption>
        )}
      </Select>
      <span className={`identity-logo-art ${which}`} style={{ background: which === "dark" ? t.colors.primary : t.colors.bg }}>
        {t.logo[which] && brandLinks[t.logo[which]!] ? <img src={brandLinks[t.logo[which]!]} alt="" /> : <Sparkles size={14} />}
      </span>
    </label>
  );

  return (
    <div className="identity-editor">
      <div className="identity-form">
        <div className="identity-row">
          <label className="identity-field">
            <span className="identity-label">Nome</span>
            <Input value={draft.name} maxLength={80} placeholder="Ex.: Corporativo azul" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="identity-field">
            <span className="identity-label">Quando usar</span>
            <Input
              value={draft.description}
              maxLength={300}
              placeholder="Ex.: propostas e relatórios para diretoria"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
        </div>

        <section className="identity-block">
          <h4>
            <Palette size={14} aria-hidden="true" /> Cores
          </h4>
          <div className="identity-colors">
            {(Object.keys(COLOR_LABELS) as (keyof IdentityColors)[]).map((k) => (
              <div key={k} className="identity-color">
                <input type="color" value={t.colors[k]} aria-label={COLOR_LABELS[k]} onChange={(e) => setColor(k, e.target.value)} />
                <span>
                  {COLOR_LABELS[k]}
                  <HexInput label={COLOR_LABELS[k]} value={t.colors[k]} onChange={(v) => setColor(k, v)} />
                </span>
              </div>
            ))}
          </div>
          {brand && brand.colors.length > 0 && (
            <p className="identity-brand-colors">
              Cores da Marca:{" "}
              {brand.colors.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  title={`Usar ${c.name || c.hex} como principal`}
                  style={{ background: c.hex }}
                  onClick={() => set({ colors: { ...t.colors, primary: c.hex, on_primary: readableOn(c.hex, t.colors.ink) } })}
                />
              ))}
            </p>
          )}
          {issues.length > 0 && <p className="identity-warn">Atenção: {issues.join("; ")}.</p>}
        </section>

        <section className="identity-block">
          <h4>
            <Type size={14} aria-hidden="true" /> Fontes
          </h4>
          {fontFields("heading", "Títulos")}
          {fontFields("body", "Texto")}
        </section>

        <section className="identity-block">
          <h4>Logos e forma</h4>
          {draft.scope !== "client" && clients && (
            <label className="identity-field">
              <span className="identity-label">Logos e fontes da Marca de</span>
              <Select aria-label="Cliente dos logos e fontes" value={picked ?? "none"} onValueChange={(v) => setPicked(v === "none" ? null : v)}>
                <SelectOption value="none">Nenhum cliente</SelectOption>
                {clients.map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {c.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
          )}
          {(images.length > 0 || t.logo.light || t.logo.dark) && (
            <div className="identity-logos">
              {logoField("light", "Logo para fundo claro")}
              {logoField("dark", "Logo para fundo escuro")}
            </div>
          )}
          <div className="identity-row">
            <label className="identity-field">
              <span className="identity-label">Capa</span>
              <Select aria-label="Capa" value={t.cover} onValueChange={(v) => set({ cover: v as IdentityTokens["cover"] })}>
                {COVERS.map((c) => (
                  <SelectOption key={c} value={c}>
                    {COVER_LABELS[c]}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <label className="identity-field">
              <span className="identity-label">Detalhe</span>
              <Select aria-label="Detalhe" value={t.decor} onValueChange={(v) => set({ decor: v as IdentityTokens["decor"] })}>
                {DECORS.map((c) => (
                  <SelectOption key={c} value={c}>
                    {DECOR_LABELS[c]}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <label className="identity-field">
              <span className="identity-label">Cantos: {t.radius === 0 ? "retos" : `${t.radius}px`}</span>
              <input type="range" min={0} max={40} value={t.radius} onChange={(e) => set({ radius: Number(e.target.value) })} />
            </label>
          </div>
        </section>

        <section className="identity-block">
          <h4>Guia da marca</h4>
          <small>
            O que não cabe nas cores e fontes: essência, tom de voz, o que fazer e evitar, exemplos aprovados e
            aprendizados. A MAVI lê antes de escrever e montar os documentos.
          </small>
          <Textarea
            aria-label="Guia da marca"
            rows={12}
            maxLength={30000}
            value={draft.guide}
            onChange={(e) => setDraft({ ...draft, guide: e.target.value })}
          />
          <div className="identity-guide-actions">
            {!draft.guide.trim() && (
              <button type="button" className="link-btn" onClick={() => setDraft({ ...draft, guide: GUIDE_TEMPLATE })}>
                Começar pelo modelo
              </button>
            )}
            {draft.guide.trim() && (
              <button
                type="button"
                className="link-btn"
                onClick={() =>
                  saveBlob(
                    fileName(`guia-da-marca-${draft.name}`, "md"),
                    new Blob([`# ${draft.name}\n\n${draft.description ? `${draft.description}\n\n` : ""}${draft.guide.trim()}\n`], { type: "text/markdown" }),
                  )
                }
              >
                <Download size={13} /> Baixar .md
              </button>
            )}
            <small>{draft.guide.length.toLocaleString("pt-BR")} / 30.000</small>
          </div>
        </section>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="identity-actions">
          {draft.id && (
            <Input aria-label="O que mudou" placeholder="O que mudou (opcional)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          )}
          {onCancel && (
            <Button className="btn secondary" onClick={onCancel}>
              Fechar
            </Button>
          )}
          <Button className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Salvando…" : draft.id ? "Salvar versão" : "Criar"}
          </Button>
        </div>

        {full && full.versions.length > 0 && (
          <details className="identity-versions">
            <summary>
              <History size={13} aria-hidden="true" /> Versões ({full.versions.length})
            </summary>
            <ul>
              {full.versions.map((v) => (
                <li key={v.version}>
                  <span>
                    <strong>v{v.version}</strong> · {new Date(v.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                    {v.author_name ? ` · ${v.author_name}` : ""}
                    {v.reason ? ` — ${v.reason}` : ""}
                  </span>
                  {v.version !== full.version && (
                    <button type="button" className="link-btn" onClick={() => void restore(v.version)}>
                      <RotateCcw size={12} /> Restaurar
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="identity-side">
        <IdentityPreview company={company} look={look} />
      </div>
    </div>
  );
}

/**
 * Drive › cliente › Marca: o Guia da marca do cliente (a identidade dele nos
 * documentos e apresentações). Sem guia, nasce das cores, fontes e logos da
 * Marca.
 */
export function ClientGuide({
  company,
  client,
  clientName,
  brand,
  notify,
}: {
  company: string;
  client: string;
  clientName: string;
  brand: Brand;
  notify: (message: string) => void;
}) {
  const [identity, setIdentity] = useState<IdentityFull | null | undefined>(undefined);
  const [editing, setEditing] = useState<IdentityDraft | null>(null);
  const load = () =>
    clientIdentity(company, client)
      .then(setIdentity)
      .catch(() => setIdentity(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, client]);
  if (identity === undefined) return <Loading compact />;
  const fromBrand = () =>
    newDraft("client", client, {
      name: `Marca de ${clientName}`,
      description: `Documentos e apresentações de ${clientName}.`,
      tokens: tokensFromBrand(brand),
    });
  return (
    <section className="panel brand-section brand-wide identity-client" aria-label="Guia da marca">
      <h3>
        <Palette size={15} aria-hidden="true" /> Guia da marca (documentos e apresentações)
      </h3>
      <small>
        O tema que a MAVI aplica nos PDFs, PowerPoints, documentos do Word e páginas que gera para {clientName}, e o guia
        que ela segue ao escrever. Sem guia, ela monta o tema com as cores, fontes e logos acima.
      </small>
      {editing ? (
        <IdentityEditor
          company={company}
          initial={editing}
          notify={notify}
          onSaved={() => void load()}
          onCancel={() => setEditing(null)}
        />
      ) : identity ? (
        <div className="identity-summary">
          <div className="identity-summary-art">
            <IdentityPreview company={company} look={{ ...sanitizeTokens(identity.tokens), id: identity.id, name: identity.name, source: "client" }} compact />
          </div>
          <div>
            <strong>{identity.name}</strong>
            <p className="muted">
              Versão {identity.version}
              {identity.updated_by_name ? ` · ${identity.updated_by_name}` : ""} ·{" "}
              {new Date(identity.updated_at).toLocaleDateString("pt-BR")}
              {identity.guide.trim() ? ` · guia com ${identity.guide.length.toLocaleString("pt-BR")} caracteres` : " · sem guia escrito"}
            </p>
            <Button className="btn secondary" onClick={() => setEditing(draftOf(identity))}>
              Abrir e editar
            </Button>
          </div>
        </div>
      ) : (
        <div className="identity-summary">
          <p className="muted">Este cliente ainda não tem Guia da marca.</p>
          <Button className="btn secondary" onClick={() => setEditing(fromBrand())}>
            <Sparkles size={14} /> Criar a partir da Marca
          </Button>
        </div>
      )}
    </section>
  );
}
