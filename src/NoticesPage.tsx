import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BellRing,
  CalendarClock,
  CheckCircle2,
  Eye,
  Inbox,
  Monitor,
  PanelTop,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Repeat,
  Search,
  Send,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { Empty, Modal } from "./components";
import { Button, Loading } from "./ui";
import { RichTextContent } from "./RichTextContent";
import { LevelChip, NoticeAttachments } from "./NoticeParts";
import { NoticeForm } from "./NoticeForm";
import {
  NOTICE_PARAM,
  noticesApi,
  REPEATS,
  STATUS_LABEL,
  whenLabel,
  type FeedNotice,
  type NoticeDetail,
  type NoticesApi,
  type NoticeSaveResult,
  type SentNotice,
} from "./notices";
import { useUrlState } from "./router";
import type { Snapshot } from "./types";

const PAGE = 20;

/**
 * Mural de avisos: o que a pessoa recebeu ("Para mim", fixados no ar
 * primeiro) e, para administradores e gestores, o que enviaram, com a
 * entrega da rodada atual. A lista se atualiza pelos avisos ao vivo.
 */
export function NoticesPage({
  data,
  company,
  user,
  isLeader,
  demo,
  notify,
}: {
  data: Snapshot;
  company: string;
  user: string;
  isLeader: boolean;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const api = useMemo(() => noticesApi(demo, data, user), [demo]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTab] = useUrlState<string>("aba", "");
  const [openId, setOpenId] = useUrlState<string>(NOTICE_PARAM, "");
  const [typed, setTyped] = useState("");
  const [term, setTerm] = useState("");
  const [feed, setFeed] = useState<FeedNotice[] | null>(null);
  const [sent, setSent] = useState<SentNotice[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState<{ detail: NoticeDetail | null } | null>(
    null,
  );
  const sending = isLeader && tab === "enviados";
  const request = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setTerm(typed.trim()), 280);
    return () => clearTimeout(t);
  }, [typed]);

  const load = useCallback(
    (offset = 0) => {
      const n = ++request.current;
      if (!offset) setError("");
      const done = <T,>(
        list: T[],
        set: (f: (p: T[] | null) => T[]) => void,
      ) => {
        if (n !== request.current) return;
        set((prev) => (offset && prev ? [...prev, ...list] : list));
        setMore(list.length === PAGE);
      };
      const failed = (e: unknown) => {
        if (n === request.current)
          setError(
            (e as Error).message || "Não foi possível carregar os avisos.",
          );
      };
      if (sending)
        api
          .sent(company, term, PAGE, offset)
          .then((l) => done(l, setSent), failed);
      else
        api
          .feed(company, term, PAGE, offset)
          .then((l) => done(l, setFeed), failed);
    },
    [api, company, sending, term],
  );
  useEffect(() => load(0), [load]);

  // Avisos ao vivo (App.tsx repassa como "mavi:notices"): agrupa rajadas.
  const soon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => {
    clearTimeout(soon.current);
    soon.current = setTimeout(() => load(0), 400);
  }, [load]);
  useEffect(() => {
    window.addEventListener("mavi:notices", refresh);
    return () => {
      window.removeEventListener("mavi:notices", refresh);
      clearTimeout(soon.current);
    };
  }, [refresh]);

  const saved = (r: NoticeSaveResult, published: boolean) => {
    setForm(null);
    notify(
      !published
        ? "Rascunho salvo. Só você vê até publicar."
        : r.status === "scheduled"
          ? "Aviso agendado."
          : "Aviso publicado.",
    );
    if (isLeader) setTab("enviados");
    setOpenId(r.id);
    refresh();
  };
  const rows = sending ? sent : feed;

  return (
    <div className="notices-page">
      <section className="cases-top">
        <label className="cases-search">
          <Search size={20} aria-hidden="true" />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Busque nos avisos…"
            aria-label="Buscar avisos"
          />
          {typed && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Limpar busca"
              onClick={() => setTyped("")}
            >
              <X size={16} />
            </button>
          )}
        </label>
        {isLeader && (
          <Button
            className="btn primary"
            onClick={() => setForm({ detail: null })}
          >
            <Plus size={17} /> Novo aviso
          </Button>
        )}
      </section>

      {isLeader && (
        <nav className="cases-tabs" aria-label="Mural">
          <button
            type="button"
            className={!sending ? "active" : ""}
            aria-current={!sending ? "page" : undefined}
            onClick={() => setTab("")}
          >
            <Inbox size={16} /> Para mim
          </button>
          <button
            type="button"
            className={sending ? "active" : ""}
            aria-current={sending ? "page" : undefined}
            onClick={() => setTab("enviados")}
          >
            <Send size={16} /> Enviados
          </button>
        </nav>
      )}

      {error && <p className="form-error">{error}</p>}
      {rows === null && !error ? (
        <Loading compact />
      ) : rows && rows.length ? (
        <>
          <ul className="notice-list">
            {sending
              ? sent!.map((n) => (
                  <SentRow key={n.id} row={n} onOpen={() => setOpenId(n.id)} />
                ))
              : feed!.map((n) => (
                  <FeedRow key={n.id} row={n} onOpen={() => setOpenId(n.id)} />
                ))}
          </ul>
          {more && (
            <div className="cases-more">
              <Button
                className="btn secondary"
                onClick={() => load(rows.length)}
              >
                Carregar mais
              </Button>
            </div>
          )}
        </>
      ) : rows ? (
        <div className="panel">
          {term ? (
            <Empty
              title="Nenhum aviso encontrado"
              body="Tente outras palavras."
            />
          ) : sending ? (
            <Empty
              title="Você ainda não enviou avisos"
              body="Avise pessoas, equipes, clientes ou projetos por popup, caixa de entrada, push ou uma faixa no topo."
              action={
                <Button
                  className="btn primary"
                  onClick={() => setForm({ detail: null })}
                >
                  <Plus size={16} /> Novo aviso
                </Button>
              }
            />
          ) : (
            <Empty
              title="Nenhum aviso por aqui"
              body="Os comunicados da agência para você aparecem aqui e ficam guardados."
            />
          )}
        </div>
      ) : null}

      {openId && !form && (
        <NoticeView
          key={openId}
          api={api}
          id={openId}
          notify={notify}
          onClose={() => setOpenId("")}
          onEdit={(detail) => setForm({ detail })}
          onChanged={refresh}
        />
      )}
      {form && (
        <NoticeForm
          api={api}
          company={company}
          data={data}
          user={user}
          demo={demo}
          detail={form.detail}
          onClose={() => setForm(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}

function FeedRow({ row, onOpen }: { row: FeedNotice; onOpen: () => void }) {
  const pinned = row.pinned && row.status === "live";
  return (
    <li>
      <button
        type="button"
        className={`notice-row ${row.level} ${row.seen_at ? "" : "unseen"} ${row.status === "ended" ? "ended" : ""}`}
        onClick={onOpen}
      >
        <span className="notice-row-mark" aria-hidden="true" />
        <span className="notice-row-main">
          <span className="notice-row-top">
            <LevelChip level={row.level} />
            {pinned && (
              <span className="notice-pin">
                <Pin size={12} /> Fixado
              </span>
            )}
            {row.status === "ended" && (
              <span className="notice-status ended">Encerrado</span>
            )}
            {row.require_ack && (
              <span className={`notice-ack ${row.acked_at ? "done" : ""}`}>
                <CheckCircle2 size={12} />
                {row.acked_at ? "Confirmado" : "Pede confirmação"}
              </span>
            )}
          </span>
          <strong>{row.title}</strong>
          {row.excerpt && (
            <small className="notice-row-excerpt">{row.excerpt}</small>
          )}
          <small className="notice-row-meta">
            {row.author_name} · {whenLabel(row.delivered_at)}
            {row.attachments > 0 && (
              <>
                {" · "}
                <Paperclip size={12} aria-hidden="true" /> {row.attachments}
              </>
            )}
          </small>
        </span>
        {!row.seen_at && <span className="notice-dot" aria-label="Não visto" />}
      </button>
    </li>
  );
}

const FORMAT_ICONS = [
  { key: "popup", icon: Monitor, label: "Popup" },
  { key: "inbox", icon: Inbox, label: "Caixa de entrada" },
  { key: "push", icon: Smartphone, label: "Push" },
  { key: "banner", icon: PanelTop, label: "Faixa no topo" },
] as const;

function SentRow({ row, onOpen }: { row: SentNotice; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        className={`notice-row ${row.level}`}
        onClick={onOpen}
      >
        <span className="notice-row-mark" aria-hidden="true" />
        <span className="notice-row-main">
          <span className="notice-row-top">
            <span className={`notice-status ${row.status}`}>
              {STATUS_LABEL[row.status]}
            </span>
            <LevelChip level={row.level} />
            <span className="notice-formats-icons">
              {FORMAT_ICONS.filter((f) => row[f.key]).map((f) => (
                <f.icon key={f.key} size={13} aria-label={f.label} />
              ))}
            </span>
            {row.repeat && (
              <span className="notice-pin">
                <Repeat size={12} />{" "}
                {REPEATS.find((r) => r.value === row.repeat)?.label}
              </span>
            )}
          </span>
          <strong>{row.title}</strong>
          <small className="notice-row-meta">
            {row.status === "scheduled"
              ? `Publica ${whenLabel(row.publish_at)}`
              : row.status === "draft"
                ? `Editado ${whenLabel(row.updated_at)}`
                : `Publicado ${whenLabel(row.publish_at)}`}
            {" · "}
            {row.author_name}
          </small>
        </span>
        {row.status !== "draft" && row.status !== "scheduled" && (
          <span className="notice-reach" title="Na rodada atual">
            <strong>
              {row.seen}/{row.delivered}
            </strong>
            <small>viram</small>
            {row.require_ack && <small>{row.acked} confirmaram</small>}
          </span>
        )}
      </button>
    </li>
  );
}

/** Um aviso aberto: quem o recebeu o marca como visto e confirma, quem o criou edita. */
function NoticeView({
  api,
  id,
  notify,
  onClose,
  onEdit,
  onChanged,
}: {
  api: NoticesApi;
  id: string;
  notify: (message: string) => void;
  onClose: () => void;
  onEdit: (detail: NoticeDetail) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<NoticeDetail | null | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api
      .detail(id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        // Abrir é ver (e lê a caixa de entrada).
        if (d?.receipt && !d.receipt.seen_at)
          void api.mark(id, "seen").then(onChanged, () => {});
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [api, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<void>, done: string, close = false) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      notify(done);
      onChanged();
      if (close) onClose();
      else setDetail(await api.detail(id));
    } catch (e) {
      setError((e as Error).message || "Não foi possível concluir.");
    } finally {
      setBusy(false);
    }
  };

  if (detail === undefined && !error)
    return (
      <Modal title="Aviso" onClose={onClose}>
        <Loading compact />
      </Modal>
    );
  if (!detail)
    return (
      <Modal title="Aviso" onClose={onClose}>
        <Empty
          title="Aviso indisponível"
          body={error || "Ele foi apagado ou não é para você."}
        />
      </Modal>
    );
  const r = detail.receipt;
  return (
    <Modal
      title={detail.title}
      onClose={onClose}
      busy={busy}
      className="notice-view-modal"
    >
      <div className="notice-view">
        <div className="notice-row-top">
          <span className={`notice-status ${detail.status}`}>
            {STATUS_LABEL[detail.status]}
          </span>
          <LevelChip level={detail.level} />
          {detail.pinned && (
            <span className="notice-pin">
              <Pin size={12} /> Fixado
            </span>
          )}
        </div>
        <p className="notice-view-meta">
          <BellRing size={14} aria-hidden="true" /> {detail.author_name}
          {detail.publish_at &&
            ` · ${detail.status === "scheduled" ? "publica" : "publicado"} ${whenLabel(detail.publish_at)}`}
          {detail.expires_at && ` · sai do ar ${whenLabel(detail.expires_at)}`}
        </p>
        {detail.repeat && (
          <p className="notice-view-meta">
            <Repeat size={14} aria-hidden="true" />
            {REPEATS.find((x) => x.value === detail.repeat)?.label}
            {detail.next_repeat && detail.status === "live"
              ? ` · próxima ${whenLabel(detail.next_repeat)}`
              : ""}
          </p>
        )}
        {detail.body ? (
          <div className="notice-view-body">
            <RichTextContent value={detail.body} />
          </div>
        ) : null}
        <NoticeAttachments api={api} items={detail.attachments} />
        {r && detail.require_ack && detail.status === "live" && (
          <div className={`notice-ack-box ${r.acked_at ? "done" : ""}`}>
            {r.acked_at ? (
              <>
                <CheckCircle2 size={18} /> Você confirmou{" "}
                {whenLabel(r.acked_at)}.
              </>
            ) : (
              <>
                <span>Este aviso pede a sua confirmação.</span>
                <Button
                  className="btn primary"
                  loading={busy}
                  onClick={() => act(() => api.mark(id, "ack"), "Confirmado.")}
                >
                  Li e entendi
                </Button>
              </>
            )}
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        {detail.can_edit && (
          <div className="form-footer notice-view-actions">
            <Button
              className="btn secondary danger"
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "Apagar o aviso? Ele some do Mural e da caixa de entrada de todos.",
                  )
                )
                  return;
                void act(() => api.remove(id), "Aviso apagado.", true);
              }}
            >
              <Trash2 size={16} /> Apagar
            </Button>
            {(detail.status === "live" || detail.status === "scheduled") && (
              <Button
                className="btn secondary"
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Encerrar agora? O aviso sai do ar para todos e fica no histórico.",
                    )
                  )
                    return;
                  void act(() => api.end(id), "Aviso encerrado.");
                }}
              >
                <CalendarClock size={16} /> Encerrar agora
              </Button>
            )}
            {detail.status !== "ended" && (
              <Button
                className="btn primary"
                disabled={busy}
                onClick={() => onEdit(detail)}
              >
                <Pencil size={16} /> Editar
              </Button>
            )}
          </div>
        )}
        {detail.can_edit && !r && detail.status === "live" && (
          <p className="notice-view-meta">
            <Eye size={14} aria-hidden="true" /> Quem criou não recebe o próprio
            aviso.
          </p>
        )}
      </div>
    </Modal>
  );
}
