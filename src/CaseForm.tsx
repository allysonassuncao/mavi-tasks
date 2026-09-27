import {
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  CloudUpload,
  File as FileIcon,
  Film,
  Image as ImageIcon,
  Plus,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Select, SelectOption, Textarea } from "./ui";
import { DropOverlay, useFileDrop } from "./useFileDrop";
import { forgetMediaUrl, LINK_ICONS } from "./CaseParts";
import {
  addNiche,
  emptyContent,
  linkInfo,
  MAX_HIGHLIGHTS,
  MAX_NICHES,
  MEDIA_MAX_BYTES,
  mediaKind,
  nicheSuggestions,
  normalizeUrl,
  type CaseClient,
  type CaseContent,
  type CaseDetail,
  type CasesApi,
  type NicheCount,
  type SaveResult,
} from "./cases";
import { formatBytes } from "./drive";
import type { Product } from "./types";

const TEXT_PRESETS = [
  "Telefone",
  "WhatsApp",
  "E-mail",
  "Responsável",
  "Observação",
];

type Queued = { key: string; file: File; progress: number; error?: string };

/**
 * Cadastro e edição de um case. Salva o conteúdo primeiro (o banco decide
 * se vale na hora ou vira alteração para aprovar), depois tira as mídias
 * marcadas e envia as novas, com o progresso de cada uma. Se um envio
 * falhar, o case já está salvo: tentar de novo só reenvia o que faltou.
 */
export function CaseForm({
  api,
  company,
  detail,
  clients,
  niches,
  products,
  isLeader,
  presetClient,
  onClose,
  onSaved,
}: {
  api: CasesApi;
  company: string;
  /** The case being edited (null: a new one). */
  detail: CaseDetail | null;
  clients: CaseClient[];
  niches: NicheCount[];
  products: Pick<Product, "id" | "name" | "color">[];
  isLeader: boolean;
  presetClient?: string;
  onClose: () => void;
  onSaved: (id: string, result: SaveResult) => void;
}) {
  // An edit waiting for approval is what the author keeps editing.
  const start: CaseContent = detail
    ? detail.draft
      ? { ...emptyContent(), ...detail.draft.content }
      : {
          client_id: detail.client_id,
          title: detail.title,
          summary: detail.summary,
          highlights: detail.highlights,
          niches: detail.niches,
          product_ids: detail.product_ids,
          links: detail.links,
          contacts: detail.contacts,
        }
    : emptyContent(presetClient ?? "");
  const [form, setForm] = useState<CaseContent>(start);
  const [nicheText, setNicheText] = useState("");
  const [nicheOpen, setNicheOpen] = useState(false);
  const [remove, setRemove] = useState<string[]>([]);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Once saved, a retry only sends what is left.
  const saved = useRef<{ id: string; result: SaveResult } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof CaseContent>(key: K, value: CaseContent[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const client = clients.find((c) => c.id === form.client_id);
  const knownNiches = niches.map((n) => n.niche);
  const suggestions = nicheSuggestions(niches, nicheText, form.niches);
  const existing = (detail?.media ?? []).filter(
    (m) => !detail?.draft?.removed_media.includes(m.id),
  );
  const approvedEdit = !!detail && detail.status === "approved" && !isLeader;
  const orderedProducts = useMemo(() => {
    const contracted = new Set(client?.product_ids ?? []);
    return [...products].sort(
      (a, b) =>
        Number(contracted.has(b.id)) - Number(contracted.has(a.id)) ||
        a.name.localeCompare(b.name, "pt-BR"),
    );
  }, [products, client]);

  const addFiles = (files: File[]) => {
    const bad = files.filter((f) => f.size === 0 || f.size > MEDIA_MAX_BYTES);
    if (bad.length)
      setError(
        `${bad.map((f) => f.name).join(", ")}: envie arquivos não vazios de até 500 MB.`,
      );
    const good = files.filter((f) => !bad.includes(f));
    setQueue((q) => [
      ...q,
      ...good.map((file) => ({
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
        progress: 0,
      })),
    ]);
  };
  const drop = useFileDrop(addFiles, !busy);

  function pickClient(id: string) {
    const c = clients.find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      client_id: id,
      // The products the client hires are the likely answer.
      product_ids: f.product_ids.length
        ? f.product_ids
        : (c?.product_ids ?? []).filter((p) =>
            products.some((x) => x.id === p),
          ),
    }));
  }
  function commitNiche(value = nicheText) {
    if (form.niches.length >= MAX_NICHES) return;
    const next = addNiche(form.niches, value, knownNiches);
    if (next !== form.niches) set("niches", next);
    setNicheText("");
  }
  function nicheKey(e: KeyboardEvent<HTMLInputElement>) {
    if (
      (e.key === "Enter" || e.key === "," || e.key === "Tab") &&
      nicheText.trim()
    ) {
      e.preventDefault();
      commitNiche();
    } else if (e.key === "Backspace" && !nicheText && form.niches.length) {
      set("niches", form.niches.slice(0, -1));
    }
  }
  // Pasting several addresses (one per line) makes several links.
  function pasteLinks(index: number, e: ClipboardEvent<HTMLInputElement>) {
    const lines = e.clipboardData
      .getData("text")
      .split(/[\n\r\s]+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    const links = [...form.links];
    links.splice(index, 1, ...lines.map((url) => ({ url, label: "" })));
    set("links", links.slice(0, 30));
  }

  async function save() {
    setError("");
    if (!form.client_id) return setError("Escolha o cliente do case.");
    if (form.title.trim().length < 3)
      return setError("Dê um título ao case (o resultado em uma frase).");
    const links = form.links
      .map((l) => ({ ...l, url: normalizeUrl(l.url) || l.url.trim() }))
      .filter((l) => l.url);
    const bad = links.find((l) => !normalizeUrl(l.url));
    if (bad) return setError(`Confira o link "${bad.url}".`);
    const content: CaseContent = {
      ...form,
      title: form.title.trim(),
      summary: form.summary.trim(),
      links,
      highlights: form.highlights.filter(
        (h) => h.value.trim() || h.label.trim(),
      ),
      contacts: form.contacts.filter((t) => t.value.trim()),
      niches: nicheText.trim()
        ? addNiche(form.niches, nicheText, knownNiches)
        : form.niches,
    };
    setBusy(true);
    try {
      if (!saved.current) {
        const result = await api.save(
          company,
          detail?.id ?? null,
          content,
          detail?.version,
        );
        saved.current = { id: result.id, result };
      }
      const id = saved.current.id;
      for (const media of remove) {
        await api.removeMedia(media);
        forgetMediaUrl(media);
      }
      setRemove([]);
      for (const item of queue) {
        if (item.progress === 1 && !item.error) continue;
        try {
          await api.upload(id, item.file, (progress) =>
            setQueue((q) =>
              q.map((x) => (x.key === item.key ? { ...x, progress } : x)),
            ),
          );
          setQueue((q) =>
            q.map((x) =>
              x.key === item.key ? { ...x, progress: 1, error: undefined } : x,
            ),
          );
        } catch (e) {
          setQueue((q) =>
            q.map((x) =>
              x.key === item.key
                ? { ...x, progress: 0, error: (e as Error).message }
                : x,
            ),
          );
          throw Error(
            `O case foi salvo, mas ${item.file.name} não foi enviado: ${(e as Error).message} Tente de novo.`,
          );
        }
      }
      onSaved(id, saved.current.result);
    } catch (e) {
      setError((e as Error).message || "Não foi possível salvar o case.");
    } finally {
      setBusy(false);
    }
  }

  const hint = !detail
    ? isLeader
      ? "Como administrador/gestor, o case já entra na biblioteca."
      : "O case vai para a aprovação de um administrador ou gestor antes de aparecer para todos."
    : approvedEdit
      ? "A alteração vai para aprovação; a versão aprovada continua na biblioteca até lá."
      : detail.status === "returned" && !isLeader
        ? "Corrigido, o case volta para a aprovação."
        : "";

  return (
    <Modal
      title={detail ? "Editar case" : "Cadastrar case de sucesso"}
      onClose={onClose}
      busy={busy}
      className="case-form-modal"
    >
      <form
        className="entity-form case-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        {...drop.handlers}
      >
        {drop.active && (
          <DropOverlay
            label="Solte para adicionar ao case"
            hint="Fotos, vídeos, PDFs, qualquer arquivo"
          />
        )}
        {detail?.draft?.status === "returned" && detail.draft.review_note && (
          <p className="case-note returned">
            <strong>Devolvida:</strong> {detail.draft.review_note}
          </p>
        )}
        {detail?.status === "returned" && detail.review_note && (
          <p className="case-note returned">
            <strong>Devolvido:</strong> {detail.review_note}
          </p>
        )}

        <div className="form-columns case-form-top">
          <label>
            Cliente
            <Select
              value={form.client_id}
              onValueChange={pickClient}
              aria-label="Cliente"
              disabled={busy}
            >
              <SelectOption value="">Escolha o cliente</SelectOption>
              {clients.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  {c.archived ? `${c.name} (ex-cliente)` : c.name}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label>
            Título
            <input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Ex.: Clínica triplicou os agendamentos em 90 dias"
              maxLength={160}
              required
              disabled={busy}
            />
          </label>
        </div>

        <fieldset className="case-form-block">
          <legend>Resultados em destaque</legend>
          <small>
            Os números que vendem o case. Aparecem grandes no card e na página.
          </small>
          {form.highlights.map((h, i) => (
            <div className="case-row" key={i}>
              <input
                className="case-highlight-value"
                aria-label={`Número ${i + 1}`}
                value={h.value}
                maxLength={24}
                placeholder="+320"
                onChange={(e) =>
                  set(
                    "highlights",
                    form.highlights.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    ),
                  )
                }
                disabled={busy}
              />
              <input
                aria-label={`Descrição do número ${i + 1}`}
                value={h.label}
                maxLength={80}
                placeholder="leads por mês"
                onChange={(e) =>
                  set(
                    "highlights",
                    form.highlights.map((x, j) =>
                      j === i ? { ...x, label: e.target.value } : x,
                    ),
                  )
                }
                disabled={busy}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Tirar este resultado"
                onClick={() =>
                  set(
                    "highlights",
                    form.highlights.filter((_, j) => j !== i),
                  )
                }
                disabled={busy}
              >
                <X size={16} />
              </button>
            </div>
          ))}
          {form.highlights.length < MAX_HIGHLIGHTS && (
            <button
              type="button"
              className="text-btn"
              onClick={() =>
                set("highlights", [
                  ...form.highlights,
                  { value: "", label: "" },
                ])
              }
              disabled={busy}
            >
              <Plus size={15} /> Adicionar resultado
            </button>
          )}
        </fieldset>

        <label>
          Resumo
          <Textarea
            value={form.summary}
            onChange={(e) => set("summary", e.target.value)}
            rows={5}
            maxLength={5000}
            placeholder="O desafio do cliente, o que foi feito e o resultado. Quem ler deve conseguir contar essa história para um lead."
            disabled={busy}
          />
        </label>

        <div className="form-columns">
          <div className="case-field">
            <span className="case-field-label" id="case-niches-label">
              Nichos
            </span>
            <div
              className="case-tags"
              onClick={(e) =>
                (
                  e.currentTarget.querySelector(
                    "input",
                  ) as HTMLInputElement | null
                )?.focus()
              }
            >
              {form.niches.map((n) => (
                <span key={n} className="case-tag">
                  {n}
                  <button
                    type="button"
                    aria-label={`Tirar ${n}`}
                    onClick={() =>
                      set(
                        "niches",
                        form.niches.filter((x) => x !== n),
                      )
                    }
                    disabled={busy}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {form.niches.length < MAX_NICHES && (
                <input
                  aria-labelledby="case-niches-label"
                  value={nicheText}
                  onChange={(e) => setNicheText(e.target.value.slice(0, 60))}
                  onKeyDown={nicheKey}
                  onFocus={() => setNicheOpen(true)}
                  onBlur={() =>
                    setTimeout(() => {
                      setNicheOpen(false);
                      if (nicheText.trim()) commitNiche();
                    }, 120)
                  }
                  placeholder={
                    form.niches.length ? "" : "Odontologia, imobiliário…"
                  }
                  disabled={busy}
                />
              )}
            </div>
            {nicheOpen && (suggestions.length > 0 || nicheText.trim()) && (
              <div
                className="case-suggest"
                role="listbox"
                aria-label="Nichos sugeridos"
              >
                {suggestions.map((s) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    key={s.niche}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitNiche(s.niche)}
                  >
                    {s.niche}
                    {s.cases > 0 && (
                      <small>
                        {s.cases} {s.cases === 1 ? "case" : "cases"}
                      </small>
                    )}
                  </button>
                ))}
                {nicheText.trim() &&
                  !suggestions.some(
                    (s) =>
                      s.niche.toLowerCase() === nicheText.trim().toLowerCase(),
                  ) && (
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => commitNiche()}
                    >
                      Criar “{nicheText.trim()}”
                    </button>
                  )}
              </div>
            )}
          </div>
          <div className="case-field">
            <span className="case-field-label">Produtos da Make</span>
            <div
              className="case-products"
              role="group"
              aria-label="Produtos da Make"
            >
              {orderedProducts.map((p) => {
                const on = form.product_ids.includes(p.id);
                return (
                  <button
                    type="button"
                    key={p.id}
                    className={`chip ${on ? "selected" : ""}`}
                    aria-pressed={on}
                    onClick={() =>
                      set(
                        "product_ids",
                        on
                          ? form.product_ids.filter((x) => x !== p.id)
                          : [...form.product_ids, p.id],
                      )
                    }
                    disabled={busy}
                    title={
                      client?.product_ids.includes(p.id)
                        ? "O cliente contrata este produto"
                        : undefined
                    }
                  >
                    <i style={{ background: p.color }} aria-hidden="true" />
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <fieldset className="case-form-block">
          <legend>Mídias</legend>
          <small>
            Prints, fotos de antes e depois, vídeos de depoimento,
            apresentações. Qualquer tipo, até 500 MB cada.
          </small>
          <ul className="case-upload-list">
            {existing.map((m) => {
              const off = remove.includes(m.id);
              const kind = mediaKind(m);
              const Icon =
                kind === "image"
                  ? ImageIcon
                  : kind === "video"
                    ? Film
                    : FileIcon;
              return (
                <li key={m.id} className={off ? "removing" : ""}>
                  <Icon size={16} />
                  <span>
                    {m.name}
                    <small>
                      {formatBytes(m.size_bytes)}
                      {m.pending ? " · aguardando aprovação" : ""}
                      {off
                        ? approvedEdit && !m.pending
                          ? " · sai quando aprovarem"
                          : " · será removida"
                        : ""}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={off ? `Manter ${m.name}` : `Tirar ${m.name}`}
                    onClick={() =>
                      setRemove((r) =>
                        off ? r.filter((x) => x !== m.id) : [...r, m.id],
                      )
                    }
                    disabled={busy}
                  >
                    {off ? <Undo2 size={15} /> : <Trash2 size={15} />}
                  </button>
                </li>
              );
            })}
            {queue.map((q) => (
              <li
                key={q.key}
                className={q.error ? "failed" : q.progress === 1 ? "sent" : ""}
              >
                <CloudUpload size={16} />
                <span>
                  {q.file.name}
                  <small>
                    {formatBytes(q.file.size)}
                    {q.error
                      ? ` · ${q.error}`
                      : q.progress === 1
                        ? " · enviada"
                        : busy && q.progress > 0
                          ? ` · ${Math.round(q.progress * 100)}%`
                          : " · nova"}
                  </small>
                  {busy && q.progress > 0 && q.progress < 1 && (
                    <span
                      className="case-progress"
                      style={{ ["--p" as string]: q.progress }}
                    />
                  )}
                </span>
                {q.progress < 1 && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Não enviar ${q.file.name}`}
                    onClick={() =>
                      setQueue((list) => list.filter((x) => x.key !== q.key))
                    }
                    disabled={busy}
                  >
                    <X size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="case-drop"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            <CloudUpload size={20} />
            <span>
              <strong>Escolher arquivos</strong> ou arraste para cá
            </span>
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </fieldset>

        <fieldset className="case-form-block">
          <legend>Links</legend>
          <small>
            Site, landing page, Instagram, vídeo no YouTube… Cole vários de uma
            vez, um por linha.
          </small>
          {form.links.map((l, i) => {
            const url = normalizeUrl(l.url);
            const info = url ? linkInfo({ url, label: l.label }) : null;
            const Icon = LINK_ICONS[info?.kind ?? "site"];
            return (
              <div className="case-row" key={i}>
                <span className="case-row-icon" aria-hidden="true">
                  <Icon size={16} />
                </span>
                <input
                  aria-label={`Endereço do link ${i + 1}`}
                  value={l.url}
                  placeholder="instagram.com/cliente"
                  onChange={(e) =>
                    set(
                      "links",
                      form.links.map((x, j) =>
                        j === i ? { ...x, url: e.target.value } : x,
                      ),
                    )
                  }
                  onPaste={(e) => pasteLinks(i, e)}
                  onBlur={() =>
                    url &&
                    url !== l.url &&
                    set(
                      "links",
                      form.links.map((x, j) => (j === i ? { ...x, url } : x)),
                    )
                  }
                  disabled={busy}
                />
                <input
                  aria-label={`Nome do link ${i + 1}`}
                  value={l.label}
                  maxLength={80}
                  placeholder={info?.title ?? "Nome (opcional)"}
                  onChange={(e) =>
                    set(
                      "links",
                      form.links.map((x, j) =>
                        j === i ? { ...x, label: e.target.value } : x,
                      ),
                    )
                  }
                  disabled={busy}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Tirar este link"
                  onClick={() =>
                    set(
                      "links",
                      form.links.filter((_, j) => j !== i),
                    )
                  }
                  disabled={busy}
                >
                  <X size={16} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="text-btn"
            onClick={() =>
              set("links", [...form.links, { url: "", label: "" }])
            }
            disabled={busy || form.links.length >= 30}
          >
            <Plus size={15} /> Adicionar link
          </button>
        </fieldset>

        <fieldset className="case-form-block">
          <legend>Textos</legend>
          <small>
            Telefone ou e-mail de contato do cliente, quem indicar, observações.
            Telefones e e-mails viram botões.
          </small>
          {form.contacts.map((t, i) => (
            <div className="case-row" key={i}>
              <input
                aria-label={`Nome do texto ${i + 1}`}
                value={t.label}
                maxLength={40}
                placeholder="Telefone"
                list="case-text-presets"
                onChange={(e) =>
                  set(
                    "contacts",
                    form.contacts.map((x, j) =>
                      j === i ? { ...x, label: e.target.value } : x,
                    ),
                  )
                }
                disabled={busy}
              />
              <input
                aria-label={`Conteúdo do texto ${i + 1}`}
                className="case-text-value"
                value={t.value}
                maxLength={500}
                placeholder="(11) 99999-0000"
                onChange={(e) =>
                  set(
                    "contacts",
                    form.contacts.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    ),
                  )
                }
                disabled={busy}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Tirar este texto"
                onClick={() =>
                  set(
                    "contacts",
                    form.contacts.filter((_, j) => j !== i),
                  )
                }
                disabled={busy}
              >
                <X size={16} />
              </button>
            </div>
          ))}
          <datalist id="case-text-presets">
            {TEXT_PRESETS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <div className="case-presets">
            {TEXT_PRESETS.map((p) => (
              <button
                type="button"
                key={p}
                className="chip"
                onClick={() =>
                  set("contacts", [...form.contacts, { label: p, value: "" }])
                }
                disabled={busy || form.contacts.length >= 20}
              >
                <Plus size={12} /> {p}
              </button>
            ))}
          </div>
        </fieldset>

        {error && <p className="form-error">{error}</p>}
        <div className="form-footer case-form-footer">
          {hint && <small className="case-form-hint">{hint}</small>}
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy}>
            {detail
              ? approvedEdit
                ? "Enviar alteração"
                : "Salvar"
              : isLeader
                ? "Publicar case"
                : "Enviar para aprovação"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
