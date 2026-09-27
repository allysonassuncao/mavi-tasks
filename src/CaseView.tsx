import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Check,
  Clock3,
  Copy,
  Eye,
  Link2,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Loading, Textarea } from "./ui";
import {
  HighlightTiles,
  LinkList,
  MediaGallery,
  NicheChips,
  TextList,
  type UrlLoader,
} from "./CaseParts";
import {
  publicCaseUrl,
  statusLabel,
  type CaseContent,
  type CaseDetail,
  type CasesApi,
  type CaseShare,
} from "./cases";
import type { Product } from "./types";

const date = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "America/Sao_Paulo",
      })
    : "";

/** What an edit waiting for approval changes, in words. */
export function draftChanges(d: CaseDetail) {
  if (!d.draft) return [];
  const c = d.draft.content;
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const out: string[] = [];
  if (c.client_id !== d.client_id)
    out.push(`cliente (${d.draft.client_name ?? "outro"})`);
  if (c.title !== d.title) out.push("título");
  if (c.summary !== d.summary) out.push("resumo");
  if (!same(c.highlights, d.highlights)) out.push("resultados em destaque");
  if (!same(c.niches, d.niches)) out.push("nichos");
  if (!same([...c.product_ids].sort(), [...d.product_ids].sort()))
    out.push("produtos");
  if (!same(c.links, d.links)) out.push("links");
  if (!same(c.contacts, d.contacts)) out.push("textos");
  const added = d.media.filter((m) => m.pending).length;
  const removed = d.draft.removed_media.length;
  if (added)
    out.push(`${added} ${added === 1 ? "mídia nova" : "mídias novas"}`);
  if (removed)
    out.push(
      `${removed} ${removed === 1 ? "mídia removida" : "mídias removidas"}`,
    );
  return out;
}

export function CaseView({
  api,
  id,
  products,
  notify,
  internalUrl,
  onEdit,
  onClose,
  onChanged,
  onPickNiche,
}: {
  api: CasesApi;
  id: string;
  products: Pick<Product, "id" | "name" | "color">[];
  notify: (message: string) => void;
  internalUrl: (id: string) => string;
  onEdit: (detail: CaseDetail) => void;
  onClose: () => void;
  /** Something changed (approved, deleted…): the list reloads. */
  onChanged: () => void;
  onPickNiche: (niche: string) => void;
}) {
  const [detail, setDetail] = useState<CaseDetail | null | undefined>(
    undefined,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState("");
  const [proposed, setProposed] = useState(false);
  const [sharing, setSharing] = useState(false);

  const load = useCallback(() => {
    api
      .detail(id)
      .then((d) => {
        setDetail(d);
        setError("");
      })
      .catch((e) =>
        setError((e as Error).message || "Não foi possível abrir o case."),
      );
  }, [api, id]);
  useEffect(load, [load]);
  // Aprovado, editado ou apagado por outra pessoa: a tela acompanha.
  useEffect(() => {
    const onLive = (e: Event) => {
      const change = (e as CustomEvent<{ case?: string }>).detail;
      if (!change?.case || change.case === id) load();
    };
    window.addEventListener("mavi:cases", onLive);
    return () => window.removeEventListener("mavi:cases", onLive);
  }, [id, load]);

  const loader: UrlLoader = useCallback(
    (ids, inline) => api.mediaUrls(ids, inline),
    [api],
  );
  const changes = useMemo(() => (detail ? draftChanges(detail) : []), [detail]);

  async function run(
    label: string,
    action: () => Promise<unknown>,
    done?: () => void,
  ) {
    setBusy(true);
    setError("");
    try {
      await action();
      notify(label);
      onChanged();
      done ? done() : load();
    } catch (e) {
      setError((e as Error).message || "Não foi possível concluir.");
    } finally {
      setBusy(false);
    }
  }

  if (detail === undefined && !error)
    return (
      <Modal
        title="Case de sucesso"
        onClose={onClose}
        wide
        className="case-view-modal"
      >
        <Loading compact />
      </Modal>
    );
  if (!detail)
    return (
      <Modal title="Case de sucesso" onClose={onClose} className="case-missing">
        <div className="entity-form">
          <p>
            {error || "Este case não existe mais ou você não tem acesso a ele."}
          </p>
          <div className="form-footer">
            <Button className="btn secondary" onClick={onClose}>
              Fechar
            </Button>
          </div>
        </div>
      </Modal>
    );

  const d = detail;
  const draft = d.draft;
  // A alteração proposta, para quem aprova (ou o autor) comparar.
  const shown: CaseContent & { client_name: string } =
    proposed && draft
      ? { ...draft.content, client_name: draft.client_name ?? d.client_name }
      : d;
  const media =
    proposed && draft
      ? d.media.filter((m) => !draft.removed_media.includes(m.id))
      : d.media.filter((m) => !m.pending || !draft);
  const productList = products.filter((p) => shown.product_ids.includes(p.id));
  const waiting = d.status === "pending" || draft?.status === "pending";
  const approve = () =>
    run(
      draft?.status === "pending"
        ? "Alteração aprovada."
        : "Case aprovado e publicado.",
      () => api.review(d.id, true),
    );
  const giveBack = () =>
    run(
      "Devolvido ao autor com o motivo.",
      () => api.review(d.id, false, note),
      () => {
        setReturning(false);
        setNote("");
        load();
      },
    );

  return (
    <Modal
      title="Case de sucesso"
      onClose={onClose}
      wide
      busy={busy}
      className="case-view-modal"
    >
      <div className="case-view">
        {d.can_review && waiting && (
          <section className="case-review-bar" aria-label="Aprovação">
            <div>
              <strong>
                <Clock3 size={16} />
                {draft?.status === "pending"
                  ? `${draft.submitted_by_name} alterou este case`
                  : `${d.author_name} cadastrou este case`}
              </strong>
              <small>
                {draft?.status === "pending"
                  ? `Mudou ${changes.join(", ") || "o conteúdo"} · ${date(draft.submitted_at)}. A versão aprovada segue no ar até você decidir.`
                  : `Enviado em ${date(d.submitted_at)}. Só aparece para todos depois de aprovado.`}
              </small>
            </div>
            <div className="case-review-actions">
              {draft?.status === "pending" && (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setProposed((p) => !p)}
                >
                  <Eye size={16} />{" "}
                  {proposed ? "Ver a versão aprovada" : "Ver a alteração"}
                </button>
              )}
              <Button
                className="btn secondary"
                onClick={() => setReturning(true)}
                disabled={busy}
              >
                <Undo2 size={16} /> Devolver
              </Button>
              <Button
                className="btn primary"
                onClick={approve}
                loading={busy && !returning}
              >
                <Check size={16} /> Aprovar
              </Button>
            </div>
            {returning && (
              <form
                className="case-return"
                onSubmit={(e) => {
                  e.preventDefault();
                  void giveBack();
                }}
              >
                <label>
                  O que precisa mudar?
                  <Textarea
                    autoFocus
                    rows={3}
                    maxLength={1000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Ex.: faltou o print dos resultados no gerenciador."
                  />
                </label>
                <div className="form-footer">
                  <Button
                    type="button"
                    className="btn secondary"
                    onClick={() => setReturning(false)}
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="submit"
                    className="btn primary"
                    loading={busy}
                    disabled={!note.trim()}
                  >
                    <Send size={15} /> Devolver ao autor
                  </Button>
                </div>
              </form>
            )}
          </section>
        )}

        {!d.can_review && d.can_edit && d.status === "pending" && (
          <p className="case-note">
            <Clock3 size={16} /> Em análise. Você recebe um aviso quando um
            administrador ou gestor aprovar.
          </p>
        )}
        {d.can_edit && d.status === "returned" && (
          <div className="case-note returned">
            <span>
              <strong>
                Devolvido
                {d.reviewed_by_name ? ` por ${d.reviewed_by_name}` : ""}:
              </strong>{" "}
              {d.review_note}
            </span>
            <Button className="btn primary compact" onClick={() => onEdit(d)}>
              <Pencil size={15} /> Corrigir
            </Button>
          </div>
        )}
        {draft && !d.can_review && (
          <div
            className={`case-note ${draft.status === "returned" ? "returned" : ""}`}
          >
            <span>
              {draft.status === "pending" ? (
                <>
                  <strong>Sua alteração está em análise.</strong> Enquanto isso,
                  todos veem a versão aprovada.
                </>
              ) : (
                <>
                  <strong>Alteração devolvida:</strong> {draft.review_note}
                </>
              )}
            </span>
            <span className="case-note-actions">
              <button
                type="button"
                className="btn secondary compact"
                onClick={() => setProposed((p) => !p)}
              >
                <Eye size={15} />{" "}
                {proposed ? "Ver a aprovada" : "Ver a alteração"}
              </button>
              {draft.status === "returned" && (
                <Button
                  className="btn primary compact"
                  onClick={() => onEdit(d)}
                >
                  <Pencil size={15} /> Corrigir
                </Button>
              )}
              <Button
                className="btn secondary compact"
                onClick={() =>
                  window.confirm(
                    "Desistir desta alteração? As mídias novas dela saem.",
                  ) &&
                  run("Alteração descartada.", () => api.discardDraft(d.id))
                }
                disabled={busy}
              >
                Descartar
              </Button>
            </span>
          </div>
        )}
        {proposed && draft && (
          <p className="case-proposed">Mostrando a alteração proposta</p>
        )}

        <div className="case-view-grid">
          <article className="case-main">
            <header className="case-hero">
              <span className="case-kicker">
                {shown.client_name}
                {d.client_archived && (
                  <span className="case-flag">ex-cliente</span>
                )}
                {d.status !== "approved" && (
                  <span className={`case-status ${d.status}`}>
                    {statusLabel[d.status]}
                  </span>
                )}
              </span>
              <h2>{shown.title}</h2>
              <NicheChips niches={shown.niches} onPick={onPickNiche} />
            </header>
            <HighlightTiles items={shown.highlights} />
            {shown.summary && <p className="case-summary">{shown.summary}</p>}
            <MediaGallery
              media={media}
              load={loader}
              removed={proposed ? [] : (draft?.removed_media ?? [])}
            />
          </article>

          <aside className="case-side">
            {!!productList.length && (
              <section>
                <h3>Produtos da Make</h3>
                <span className="case-product-list">
                  {productList.map((p) => (
                    <span key={p.id} className="case-product">
                      <i style={{ background: p.color }} aria-hidden="true" />
                      {p.name}
                    </span>
                  ))}
                </span>
              </section>
            )}
            {!!shown.links.length && (
              <section>
                <h3>Links</h3>
                <LinkList links={shown.links} notify={notify} />
              </section>
            )}
            {!!shown.contacts.length && (
              <section>
                <h3>Contatos e textos</h3>
                <TextList texts={shown.contacts} notify={notify} />
              </section>
            )}
            <section className="case-meta">
              <span>
                Cadastrado por <strong>{d.author_name}</strong> em{" "}
                {date(d.created_at)}
              </span>
              {d.approved_at && (
                <span className="case-meta-ok">
                  <BadgeCheck size={14} />
                  <span>
                    Aprovado em {date(d.approved_at)}
                    {d.reviewed_by_name
                      ? ` · última revisão de ${d.reviewed_by_name}`
                      : ""}
                  </span>
                </span>
              )}
            </section>
            <section className="case-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() =>
                  navigator.clipboard
                    .writeText(internalUrl(d.id))
                    .then(() =>
                      notify("Link do case copiado (para quem usa o MAVI)."),
                    )
                    .catch(() => notify("Não foi possível copiar."))
                }
              >
                <Copy size={16} /> Copiar link interno
              </button>
              {d.can_edit && d.status === "approved" && d.share && (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setSharing(true)}
                >
                  <Link2 size={16} /> Link para o lead
                  {d.share.enabled && (
                    <span className="case-dot" aria-label="ligado" />
                  )}
                </button>
              )}
              {d.can_edit && (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => onEdit(d)}
                >
                  <Pencil size={16} />{" "}
                  {d.can_review || d.status !== "approved"
                    ? "Editar"
                    : "Sugerir alteração"}
                </button>
              )}
              {d.can_delete && (
                <Button
                  className="btn danger"
                  disabled={busy}
                  onClick={() =>
                    window.confirm(
                      `Apagar o case "${d.title}"? As mídias dele também saem.`,
                    ) && run("Case apagado.", () => api.remove(d.id), onClose)
                  }
                >
                  <Trash2 size={16} /> Apagar
                </Button>
              )}
            </section>
            {error && <p className="form-error">{error}</p>}
          </aside>
        </div>
      </div>
      {sharing && d.share && (
        <ShareDialog
          api={api}
          id={d.id}
          share={d.share}
          notify={notify}
          onClose={() => setSharing(false)}
          onSaved={(share) => setDetail({ ...d, share })}
        />
      )}
    </Modal>
  );
}

function ShareDialog({
  api,
  id,
  share,
  notify,
  onClose,
  onSaved,
}: {
  api: CasesApi;
  id: string;
  share: CaseShare;
  notify: (message: string) => void;
  onClose: () => void;
  onSaved: (share: CaseShare) => void;
}) {
  const [s, setS] = useState(share);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(next: Partial<CaseShare> & { newLink?: boolean }) {
    const merged = { ...s, ...next };
    setBusy(true);
    setError("");
    try {
      const saved = await api.share(id, {
        enabled: merged.enabled,
        client: merged.client,
        contacts: merged.contacts,
        newLink: next.newLink,
      });
      setS(saved);
      onSaved(saved);
      if (next.newLink) notify("Link novo criado. O anterior parou de abrir.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const url = publicCaseUrl(s.token);
  return (
    <Modal
      title="Link para o lead"
      onClose={onClose}
      busy={busy}
      className="case-share-modal"
    >
      <div className="entity-form">
        <p className="case-share-intro">
          Uma página do case, sem login, para mandar a um prospect. Mídias e
          alterações que esperam aprovação não aparecem.
        </p>
        <label className="checkbox-label">
          <Checkbox
            checked={s.enabled}
            onCheckedChange={(v) => save({ enabled: v === true })}
            disabled={busy}
          />
          Link ligado
        </label>
        <label className="checkbox-label">
          <Checkbox
            checked={s.client}
            onCheckedChange={(v) => save({ client: v === true })}
            disabled={busy}
          />
          Mostrar o nome do cliente
        </label>
        <label className="checkbox-label">
          <Checkbox
            checked={s.contacts}
            onCheckedChange={(v) => save({ contacts: v === true })}
            disabled={busy}
          />
          Mostrar contatos e textos (telefone, e-mail…)
        </label>
        {s.enabled && (
          <div className="case-share-link">
            <input
              readOnly
              value={url}
              aria-label="Link público do case"
              onFocus={(e) => e.target.select()}
            />
            <Button
              className="btn primary"
              onClick={() =>
                navigator.clipboard
                  .writeText(url)
                  .then(() => notify("Link para o lead copiado."))
                  .catch(() => notify("Não foi possível copiar."))
              }
            >
              <Copy size={16} /> Copiar
            </Button>
          </div>
        )}
        <div className="case-share-foot">
          <small>
            {s.views === 1 ? "Aberto 1 vez" : `Aberto ${s.views} vezes`}
          </small>
          {s.enabled && (
            <button
              type="button"
              className="text-btn"
              onClick={() => save({ newLink: true })}
              disabled={busy}
            >
              <RefreshCw size={14} /> Criar link novo (o atual para de abrir)
            </button>
          )}
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
