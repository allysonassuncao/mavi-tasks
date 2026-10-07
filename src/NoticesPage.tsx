import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BellRing,
  BellPlus,
  CalendarClock,
  CheckCircle2,
  Copy,
  Eye,
  Film,
  FileStack,
  Inbox,
  Monitor,
  PanelTop,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Send,
  Smartphone,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Empty, Modal } from "./components";
import { Button, Loading } from "./ui";
import { RichTextContent } from "./RichTextContent";
import { LevelChip, NoticeAttachments, TemplateName } from "./NoticeParts";
import { NoticeForm } from "./NoticeForm";
import { NoticeStudio } from "./NoticeStudio";
import NoticeAnimationPlayer from "./NoticeAnimationPlayer";
import { specImages } from "./notice-animation";
import {
  contentOf,
  fromTemplate,
  isPending,
  NOTICE_PARAM,
  noticesApi,
  REPEATS,
  STATUS_LABEL,
  templateOf,
  whenLabel,
  type FeedNotice,
  type NoticeContent,
  type NoticeDetail,
  type NoticePerson,
  type NoticesApi,
  type NoticeSaveResult,
  type NoticeTemplate,
  type SentNotice,
} from "./notices";
import { useAddress, useUrlState } from "./router";
import { SectionLayout, type SectionNavItem } from "./SectionNav";
import { fold } from "./domain";
import type { Snapshot } from "./types";

const PAGE = 20;

// Seções do mural (só líderes); "Para mim" é o endereço sem ?aba=.
const SECTIONS: (Omit<SectionNavItem, "href"> & { aba: string })[] = [
  { id: "para-mim", aba: "", label: "Para mim", icon: Inbox },
  { id: "enviados", aba: "enviados", label: "Enviados", icon: Send },
  { id: "modelos", aba: "modelos", label: "Modelos", icon: FileStack },
];

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
  // O link "Animação pronta" da caixa de entrada abre o estúdio.
  const [studioParam, setStudioParam] = useUrlState<string>("animacao", "");
  const [typed, setTyped] = useState("");
  const [term, setTerm] = useState("");
  const [feed, setFeed] = useState<FeedNotice[] | null>(null);
  const [sent, setSent] = useState<SentNotice[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState<{
    detail: NoticeDetail | null;
    /** Um modelo ou um aviso duplicado: começa preenchido. */
    preset?: NoticeContent;
    template?: NoticeTemplate;
  } | null>(null);
  const sending = isLeader && tab === "enviados";
  const templatesTab = isLeader && tab === "modelos";
  const request = useRef(0);
  const address = useAddress();
  const tabHref = (aba: string) => {
    const url = new URL(address || "/", "http://x");
    if (aba) url.searchParams.set("aba", aba);
    else url.searchParams.delete("aba");
    return url.pathname + url.search;
  };
  const groups = isLeader
    ? [
        {
          items: SECTIONS.map(({ aba, ...item }) => ({
            ...item,
            href: tabHref(aba),
          })),
        },
      ]
    : [];

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
    <SectionLayout
      title="Mural"
      label="Seções do Mural"
      groups={groups}
      current={sending ? "enviados" : templatesTab ? "modelos" : "para-mim"}
      storageKey="mural"
      onSelect={(id) => setTab(SECTIONS.find((t) => t.id === id)?.aba ?? "")}
    >
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

        {error && <p className="form-error">{error}</p>}
        {templatesTab ? (
          <TemplateList
            api={api}
            company={company}
            query={term}
            notify={notify}
            onUse={(template) =>
              setForm({
                detail: null,
                preset: fromTemplate(template.content),
                template,
              })
            }
          />
        ) : rows === null && !error ? (
          <Loading compact />
        ) : rows && rows.length ? (
          <>
            <ul className="notice-list">
              {sending
                ? sent!.map((n) => (
                    <SentRow
                      key={n.id}
                      row={n}
                      onOpen={() => setOpenId(n.id)}
                    />
                  ))
                : feed!.map((n) => (
                    <FeedRow
                      key={n.id}
                      row={n}
                      onOpen={() => setOpenId(n.id)}
                    />
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
            company={company}
            id={openId}
            demo={demo}
            notify={notify}
            studio={studioParam === "1"}
            onStudio={(open) => setStudioParam(open ? "1" : "")}
            onClose={() => {
              setStudioParam("");
              setOpenId("");
            }}
            onEdit={(detail) => setForm({ detail })}
            onDuplicate={(detail) =>
              setForm({
                detail: null,
                preset: {
                  ...contentOf(detail),
                  title: `${detail.title} (cópia)`.slice(0, 160),
                  publish_at: "",
                  expires_at: "",
                },
              })
            }
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
            preset={form.preset}
            template={form.template}
            notify={notify}
            onClose={() => setForm(null)}
            onSaved={saved}
          />
        )}
      </div>
    </SectionLayout>
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
            <span data-person={row.created_by}>{row.author_name}</span>
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
  company,
  id,
  demo,
  notify,
  studio,
  onStudio,
  onClose,
  onEdit,
  onDuplicate,
  onChanged,
}: {
  api: NoticesApi;
  company: string;
  id: string;
  demo: boolean;
  notify: (message: string) => void;
  /** O estúdio da animação aberto (só para quem edita). */
  studio: boolean;
  onStudio: (open: boolean) => void;
  onClose: () => void;
  onEdit: (detail: NoticeDetail) => void;
  onDuplicate: (detail: NoticeDetail) => void;
  onChanged: () => void;
}) {
  const [naming, setNaming] = useState(false);
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
        <Loading variant="detail" />
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
  if (studio && detail.can_edit)
    return (
      <NoticeStudio
        api={api}
        company={company}
        notice={detail.id}
        live={detail.status === "live"}
        attachments={detail.attachments}
        demo={demo}
        notify={notify}
        onAttachments={(added) =>
          setDetail((d) =>
            d ? { ...d, attachments: [...d.attachments, ...added] } : d,
          )
        }
        onClose={() => {
          onStudio(false);
          void api.detail(id).then(setDetail, () => {});
          onChanged();
        }}
      />
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
          <BellRing size={14} aria-hidden="true" />{" "}
          <span data-person={detail.created_by}>{detail.author_name}</span>
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
        {detail.animation && (
          <NoticeAnimationPlayer
            key={detail.animation_id ?? ""}
            spec={detail.animation}
            images={specImages(detail.animation)}
            load={(ids) => api.attachmentUrls(ids, true)}
          />
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
        {detail.can_edit &&
          detail.status !== "draft" &&
          detail.status !== "scheduled" && (
            <NoticeReach
              key={`${detail.round}`}
              api={api}
              detail={detail}
              notify={notify}
              onReminded={async () => {
                onChanged();
                setDetail(await api.detail(id));
              }}
            />
          )}
        {naming && (
          <TemplateName
            initial={detail.title}
            busy={busy}
            onCancel={() => setNaming(false)}
            onSave={(name) =>
              act(async () => {
                await api.saveTemplate(
                  company,
                  null,
                  name,
                  templateOf(contentOf(detail)),
                );
                setNaming(false);
              }, "Modelo salvo. Ele aparece na aba Modelos para todos os líderes.")
            }
          />
        )}
        {error && <p className="form-error">{error}</p>}
        {detail.can_edit && (
          <div className="form-footer notice-view-actions">
            {detail.status !== "ended" && (
              <Button
                className="btn secondary"
                disabled={busy}
                onClick={() => onStudio(true)}
              >
                <Film size={16} />{" "}
                {detail.animation ? "Animação" : "Criar animação"}
              </Button>
            )}
            <Button
              className="btn secondary"
              disabled={busy}
              onClick={() => onDuplicate(detail)}
              title="Um aviso novo com o mesmo conteúdo, formatos e público (sem os anexos)"
            >
              <Copy size={16} /> Duplicar
            </Button>
            <Button
              className="btn secondary"
              disabled={busy || naming}
              onClick={() => setNaming(true)}
            >
              <FileStack size={16} /> Salvar como modelo
            </Button>
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

type ReachTab = "pending" | "seen" | "acked" | "all";

/**
 * Quem recebeu a rodada atual: pendentes primeiro, quem viu, quem confirmou.
 * A lista é lida quando abre e em "Atualizar" (ver não avisa ninguém ao vivo);
 * "Cobrar pendentes" reenvia a quem falta, uma vez por hora.
 */
function NoticeReach({
  api,
  detail,
  notify,
  onReminded,
}: {
  api: NoticesApi;
  detail: NoticeDetail;
  notify: (message: string) => void;
  onReminded: () => void;
}) {
  const [people, setPeople] = useState<NoticePerson[] | null>(null);
  const [tab, setTab] = useState<ReachTab>("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    api
      .people(detail.id)
      .then(setPeople)
      .catch((e) => setError((e as Error).message));
  }, [api, detail.id]);
  useEffect(load, [load]);
  const ack = detail.require_ack;
  const list = people ?? [];
  const pending = list.filter((p) => isPending(p, ack));
  const seen = list.filter((p) => p.seen_at);
  const acked = list.filter((p) => p.acked_at);
  const shown =
    tab === "pending"
      ? pending
      : tab === "seen"
        ? seen
        : tab === "acked"
          ? acked
          : list;
  const next = detail.last_reminded_at
    ? new Date(new Date(detail.last_reminded_at).getTime() + 3600e3)
    : null;
  const wait = next && next.getTime() > Date.now();
  const tabs: [ReachTab, string, number][] = [
    ["pending", "Pendentes", pending.length],
    ["seen", "Viram", seen.length],
    ...(ack
      ? ([["acked", "Confirmaram", acked.length]] as [
          ReachTab,
          string,
          number,
        ][])
      : []),
    ["all", "Todos", list.length],
  ];
  const state = (p: NoticePerson) =>
    p.acked_at
      ? `Confirmou ${whenLabel(p.acked_at)}`
      : p.snoozed_until && new Date(p.snoozed_until).getTime() > Date.now()
        ? "Adiou para amanhã"
        : p.seen_at
          ? `Viu ${whenLabel(p.seen_at)}${ack ? " · falta confirmar" : ""}`
          : "Ainda não viu";
  return (
    <section className="notice-reach-box" aria-label="Quem recebeu">
      <header>
        <strong>
          <Users size={15} aria-hidden="true" /> Quem recebeu
        </strong>
        <button
          type="button"
          className="text-btn"
          onClick={load}
          title="Ler a lista de novo"
        >
          <RefreshCw size={13} /> Atualizar
        </button>
      </header>
      {people === null && !error ? (
        <Loading compact />
      ) : (
        <>
          <div className="notice-reach-tabs" role="tablist">
            {tabs.map(([key, label, n]) => (
              <button
                type="button"
                role="tab"
                key={key}
                aria-selected={tab === key}
                className={tab === key ? "selected" : ""}
                onClick={() => setTab(key)}
              >
                {label} <span>{n}</span>
              </button>
            ))}
          </div>
          {shown.length ? (
            <ul className="notice-people">
              {shown.map((p) => (
                <li
                  key={p.user_id}
                  className={isPending(p, ack) ? "pending" : ""}
                >
                  <span>
                    <strong>{p.name}</strong>
                    {p.teams && <small>{p.teams}</small>}
                  </span>
                  <small>
                    {state(p)}
                    {p.reminders > 0
                      ? ` · cobrado ${p.reminders === 1 ? "1 vez" : `${p.reminders} vezes`}`
                      : ""}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="notice-people-empty">
              {tab === "pending" ? "Ninguém pendente." : "Ninguém por aqui."}
            </p>
          )}
          {detail.status === "live" && (
            <div className="notice-remind">
              <small>
                {wait
                  ? `Cobrado ${whenLabel(detail.last_reminded_at)}. Dá para cobrar de novo às ${next!.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`
                  : "Reenvia só a quem falta, pelos mesmos formatos do aviso."}
              </small>
              <Button
                className="btn secondary"
                loading={busy}
                disabled={!pending.length || !!wait}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const n = await api.remind(detail.id);
                    notify(
                      n === 1 ? "1 pessoa cobrada." : `${n} pessoas cobradas.`,
                    );
                    load();
                    onReminded();
                  } catch (e) {
                    setError(
                      (e as Error).message || "Não foi possível cobrar.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <BellPlus size={16} /> Cobrar pendentes ({pending.length})
              </Button>
            </div>
          )}
        </>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

/** A biblioteca de modelos da agência (todos os líderes usam). */
function TemplateList({
  api,
  company,
  query,
  notify,
  onUse,
}: {
  api: NoticesApi;
  company: string;
  query: string;
  notify: (message: string) => void;
  onUse: (t: NoticeTemplate) => void;
}) {
  const [list, setList] = useState<NoticeTemplate[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api
      .templates(company)
      .then(setList)
      .catch((e) => setError((e as Error).message));
  }, [api, company]);
  useEffect(load, [load]);
  if (list === null && !error) return <Loading compact />;
  const words = fold(query).split(/\s+/).filter(Boolean);
  const shown = (list ?? []).filter((t) => {
    const text = fold(`${t.name} ${t.content.title ?? ""}`);
    return words.every((w) => text.includes(w));
  });
  if (list?.length && !shown.length)
    return (
      <div className="panel">
        <Empty title="Nenhum modelo encontrado" body="Tente outras palavras." />
      </div>
    );
  if (!list?.length)
    return (
      <div className="panel">
        {error ? (
          <p className="form-error">{error}</p>
        ) : (
          <Empty
            title="Nenhum modelo ainda"
            body="Abra um aviso enviado e use “Salvar como modelo”, ou salve um modelo no formulário. Séries como “Novidades da semana” ficam a um clique."
          />
        )}
      </div>
    );
  return (
    <ul className="notice-templates">
      {shown.map((t) => (
        <li key={t.id}>
          <span>
            <strong>{t.name}</strong>
            <small>
              {t.content.title ? `${t.content.title} · ` : ""}
              <span data-person={t.created_by}>{t.author_name}</span> ·{" "}
              {whenLabel(t.updated_at)}
            </small>
          </span>
          {t.can_edit && (
            <button
              type="button"
              className="icon-btn"
              aria-label={`Apagar o modelo ${t.name}`}
              onClick={async () => {
                if (!window.confirm(`Apagar o modelo “${t.name}”?`)) return;
                try {
                  await api.deleteTemplate(t.id);
                  notify("Modelo apagado.");
                  load();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
          <Button className="btn primary" onClick={() => onUse(t)}>
            Usar
          </Button>
        </li>
      ))}
      {error && <p className="form-error">{error}</p>}
    </ul>
  );
}
