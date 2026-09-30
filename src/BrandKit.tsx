import { useCallback, useEffect, useRef, useState } from "react";
import { CloudUpload, FileText, Palette, Plus, Sparkles, Trash2, Type } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Empty } from "./components";
import {
  BRAND_ACCEPT,
  FONT_FILE,
  IMAGE_FILE,
  brandUrls,
  deleteBrandFile,
  guessFont,
  loadBrand,
  saveBrand,
  uploadBrandFile,
  type Brand,
  type BrandColor,
  type BrandFile,
  type BrandFont,
} from "./brand";

/**
 * Drive › cliente › Marca: o que a MAVI usa para criar as artes do cliente
 * com a marca de verdade — logos, fontes (com a família, o peso e para que
 * serve cada uma), cores e regras de uso. Quem atende o cliente edita.
 */

const WEIGHT_LABELS: [number, string][] = [
  [100, "100 · Thin"],
  [200, "200 · Extra Light"],
  [300, "300 · Light"],
  [400, "400 · Regular"],
  [500, "500 · Medium"],
  [600, "600 · Semibold"],
  [700, "700 · Bold"],
  [800, "800 · Extra Bold"],
  [900, "900 · Black"],
];
const HEX = /^#[0-9a-f]{6}$/i;
const size = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

type Draft = { colors: BrandColor[]; fonts: BrandFont[]; notes: string };

export function BrandKit({
  company,
  client,
  clientName,
  notify,
}: {
  company: string;
  client: string;
  clientName: string;
  notify: (message: string) => void;
}) {
  const [brand, setBrand] = useState<Brand | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>({ colors: [], fonts: [], notes: "" });
  const [dirty, setDirty] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploads, setUploads] = useState<{ key: string; name: string; progress: number }[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const b = await loadBrand(company, client);
      setBrand(b);
      if (b) {
        setDraft({ colors: b.colors, fonts: b.fonts, notes: b.notes });
        setDirty(false);
        if (b.files.length) setUrls(await brandUrls(company, client).catch(() => ({})));
      }
    } catch (e) {
      setError((e as Error).message);
      setBrand(null);
    }
  }, [company, client]);
  useEffect(() => {
    void reload();
  }, [reload]);

  // As fontes da marca carregadas no navegador, para a prévia.
  useEffect(() => {
    if (!brand) return;
    const loaded: FontFace[] = [];
    for (const f of draft.fonts) {
      const url = urls[f.file];
      if (!url || typeof FontFace === "undefined") continue;
      const face = new FontFace(`brand-${f.file}`, `url("${url}")`);
      loaded.push(face);
      face
        .load()
        .then((ff) => document.fonts.add(ff))
        .catch(() => {});
    }
    return () => loaded.forEach((f) => document.fonts.delete(f));
  }, [brand, draft.fonts, urls]);

  const change = (next: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setDirty(true);
  };

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    setError("");
    const added: BrandFont[] = [];
    for (const file of Array.from(list)) {
      const key = `${file.name}-${Date.now()}`;
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      try {
        const id = await uploadBrandFile(company, client, file, (p) =>
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))),
        );
        if (FONT_FILE.test(file.name)) added.push({ file: id, role: "", ...guessFont(file.name) });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploads((u) => u.filter((x) => x.key !== key));
      }
    }
    if (input.current) input.current.value = "";
    // As fontes novas já entram com a família e o peso do nome do arquivo.
    if (added.length) {
      const fonts = [...draft.fonts, ...added];
      try {
        await saveBrand(company, client, { ...draft, fonts });
      } catch (e) {
        setError((e as Error).message);
      }
    }
    await reload();
    notify(added.length ? "Arquivos enviados. Confira a família e o peso das fontes." : "Arquivos enviados.");
  }

  async function remove(f: BrandFile) {
    if (!window.confirm(`Tirar “${f.name}” da marca?`)) return;
    try {
      await deleteBrandFile(f.id);
      await reload();
      notify("Arquivo tirado da marca.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    const bad = draft.colors.find((c) => !HEX.test(c.hex));
    if (bad) return setError(`A cor “${bad.name || bad.hex}” precisa de um código #RRGGBB.`);
    if (draft.fonts.some((f) => !f.family.trim())) return setError("Dê o nome da família de cada fonte.");
    setSaving(true);
    setError("");
    try {
      await saveBrand(company, client, draft);
      await reload();
      notify("Marca salva: a MAVI já usa nas próximas artes.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (brand === undefined) return <Loading variant="form" />;
  if (!brand)
    return (
      <Empty
        title="Marca indisponível"
        body={error || "Só quem atende este cliente vê e edita a marca dele."}
      />
    );

  const images = brand.files.filter((f) => IMAGE_FILE.test(f.name));
  const fontFiles = new Map(brand.files.filter((f) => FONT_FILE.test(f.name)).map((f) => [f.id, f]));
  const others = brand.files.filter((f) => !IMAGE_FILE.test(f.name) && !FONT_FILE.test(f.name));
  const setFont = (i: number, next: Partial<BrandFont>) =>
    change({ fonts: draft.fonts.map((f, k) => (k === i ? { ...f, ...next } : f)) });
  const setColor = (i: number, next: Partial<BrandColor>) =>
    change({ colors: draft.colors.map((c, k) => (k === i ? { ...c, ...next } : c)) });
  // Fontes na pasta que ainda não têm família (enviadas antes, ou tiradas da lista).
  const loose = [...fontFiles.values()].filter((f) => !draft.fonts.some((x) => x.file === f.id));

  return (
    <section className="brand-kit" aria-label={`Marca de ${clientName}`}>
      <header className="brand-head">
        <div>
          <h2>
            <Palette size={18} aria-hidden="true" /> Marca de {clientName}
          </h2>
          <p>
            Logos, fontes, cores e regras que a MAVI usa para criar as artes deste cliente. Sem
            marca, ela pergunta antes ou avisa o que faltou.
          </p>
        </div>
        <div className="brand-head-actions">
          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept={BRAND_ACCEPT}
            onChange={(e) => void upload(e.target.files)}
          />
          <Button className="btn secondary" onClick={() => input.current?.click()}>
            <CloudUpload size={15} /> Enviar arquivos
          </Button>
          <Button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {uploads.map((u) => (
        <p key={u.key} className="brand-upload" aria-live="polite">
          <CloudUpload size={14} /> {u.name} <progress value={u.progress} max={1} />
        </p>
      ))}

      <div className="brand-grid">
        <section className="panel brand-section">
          <h3>
            <Sparkles size={15} aria-hidden="true" /> Logos e imagens
          </h3>
          <small>PNG, SVG, JPG ou WebP. A MAVI usa pelo nome do arquivo (ex.: logo-branco.svg).</small>
          {images.length ? (
            <div className="brand-logos">
              {images.map((f) => (
                <figure key={f.id} className="brand-logo">
                  <div className="brand-logo-art">
                    {urls[f.id] ? <img src={urls[f.id]} alt={f.name} /> : <Sparkles size={18} />}
                  </div>
                  <figcaption>
                    <span title={f.name}>{f.name}</span>
                    <Button className="icon-btn" aria-label={`Tirar ${f.name}`} onClick={() => void remove(f)}>
                      <Trash2 size={14} />
                    </Button>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="muted brand-empty">Nenhum logo ainda. Envie as versões (colorida, branca, escura).</p>
          )}
        </section>

        <section className="panel brand-section">
          <h3>
            <Palette size={15} aria-hidden="true" /> Cores
          </h3>
          <small>Na ordem de importância: a principal primeiro.</small>
          <div className="brand-colors">
            {draft.colors.map((c, i) => (
              <div key={i} className="brand-color">
                <input
                  type="color"
                  aria-label={`Cor ${c.name || i + 1}`}
                  value={HEX.test(c.hex) ? c.hex : "#000000"}
                  onChange={(e) => setColor(i, { hex: e.target.value.toUpperCase() })}
                />
                <Input
                  aria-label="Nome da cor"
                  placeholder="Nome (ex.: Laranja)"
                  value={c.name}
                  maxLength={60}
                  onChange={(e) => setColor(i, { name: e.target.value })}
                />
                <Input
                  aria-label="Código da cor"
                  className="brand-hex"
                  value={c.hex}
                  maxLength={7}
                  onChange={(e) => setColor(i, { hex: e.target.value.trim() })}
                />
                <Button
                  className="icon-btn"
                  aria-label={`Tirar a cor ${c.name || c.hex}`}
                  onClick={() => change({ colors: draft.colors.filter((_, k) => k !== i) })}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
          {draft.colors.length < 24 && (
            <Button
              className="btn secondary brand-add"
              onClick={() => change({ colors: [...draft.colors, { name: "", hex: "#FF8900" }] })}
            >
              <Plus size={14} /> Adicionar cor
            </Button>
          )}
        </section>

        <section className="panel brand-section brand-wide">
          <h3>
            <Type size={15} aria-hidden="true" /> Fontes
          </h3>
          <small>
            TTF, OTF ou WOFF. Diga a família, o peso e para que serve (títulos, textos, destaque): a
            MAVI usa pelo nome da família.
          </small>
          {draft.fonts.length ? (
            <div className="brand-fonts">
              {draft.fonts.map((f, i) => (
                <div key={f.file} className="brand-font">
                  <p
                    className="brand-font-sample"
                    style={{ fontFamily: `"brand-${f.file}", sans-serif` }}
                    aria-hidden="true"
                  >
                    Aa Bb 123 · Black Friday
                  </p>
                  <div className="brand-font-fields">
                    <Input
                      aria-label="Família"
                      placeholder="Família (ex.: Tomato Grotesk)"
                      value={f.family}
                      maxLength={80}
                      onChange={(e) => setFont(i, { family: e.target.value })}
                    />
                    <Select
                      aria-label="Peso"
                      value={String(f.weight)}
                      onValueChange={(v) => setFont(i, { weight: Number(v) })}
                    >
                      {WEIGHT_LABELS.map(([w, label]) => (
                        <SelectOption key={w} value={String(w)}>
                          {label}
                        </SelectOption>
                      ))}
                    </Select>
                    <Select
                      aria-label="Estilo"
                      value={f.style}
                      onValueChange={(v) => setFont(i, { style: v as BrandFont["style"] })}
                    >
                      <SelectOption value="normal">Normal</SelectOption>
                      <SelectOption value="italic">Itálico</SelectOption>
                    </Select>
                    <Input
                      aria-label="Para que serve"
                      placeholder="Para que serve (ex.: títulos)"
                      value={f.role}
                      maxLength={80}
                      onChange={(e) => setFont(i, { role: e.target.value })}
                    />
                  </div>
                  <small className="brand-font-file">
                    {fontFiles.get(f.file)?.name ?? "arquivo"}
                    {fontFiles.get(f.file) ? ` · ${size(fontFiles.get(f.file)!.size)}` : ""}
                    {fontFiles.get(f.file) && (
                      <Button
                        className="icon-btn"
                        aria-label={`Tirar a fonte ${f.family}`}
                        onClick={() => void remove(fontFiles.get(f.file)!)}
                      >
                        <Trash2 size={13} />
                      </Button>
                    )}
                  </small>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted brand-empty">
              Nenhuma fonte ainda. Sem a fonte da marca, a MAVI usa uma parecida do Google Fonts e avisa.
            </p>
          )}
          {loose.map((f) => (
            <p key={f.id} className="brand-loose">
              <Type size={13} /> {f.name} está na pasta sem família.{" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => change({ fonts: [...draft.fonts, { file: f.id, role: "", ...guessFont(f.name) }] })}
              >
                Usar na marca
              </button>
            </p>
          ))}
        </section>

        <section className="panel brand-section brand-wide">
          <h3>Regras de uso</h3>
          <small>Tom, o que fazer e o que evitar (ex.: “laranja só em destaque”, “logo sempre no topo”).</small>
          <Textarea
            aria-label="Regras de uso da marca"
            rows={5}
            maxLength={6000}
            value={draft.notes}
            placeholder="Ex.: fundo escuro navy; títulos em caixa alta; uma palavra em Playfair itálico laranja por título; nunca degradê no texto."
            onChange={(e) => change({ notes: e.target.value })}
          />
          {others.length > 0 && (
            <div className="brand-docs">
              {others.map((f) => (
                <p key={f.id}>
                  <FileText size={13} /> {f.name} · {size(f.size)}
                  <Button className="icon-btn" aria-label={`Tirar ${f.name}`} onClick={() => void remove(f)}>
                    <Trash2 size={13} />
                  </Button>
                </p>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
