import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AtSign,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownRight,
  ExternalLink,
  EyeOff,
  GraduationCap,
  Info,
  MessageCircle,
  Radar,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
  Tag,
  ThumbsDown,
  Users,
} from "lucide-react";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Empty, Modal } from "./components";
import { appPath, openInApp } from "./temperature";
import { taskUrl, navigate } from "./router";
import {
  CONFIDENCE_LABEL,
  DISMISS_LABEL,
  REJECT_LABEL,
  createLink,
  drainDrafts,
  fillLinks,
  pendingKeys,
  replyFeedback,
  requestDraft,
  type RejectReason,
  KIND_LABEL,
  REASON_LABEL,
  URGENCY_LABEL,
  act,
  loadList,
  loadPeople,
  loadState,
  messagePath,
  resolvedLine,
  savePersonCap,
  saveSettings,
  saveState,
  usd,
  whenBr,
  type DismissReason,
  type PersonalFilters,
  type PersonalItem,
  type PersonalKind,
  type PersonalList,
  type PersonalPerson,
  type PersonalState,
  type PersonalStatus,
} from "./personal-radar";
import { sourceUrl } from "./ai";
import "./personal-radar.css";

const ALL = "__all__";
const PAGE = 50;
const savedKey = (company: string, user: string) =>
  `mavi:personal-radar:${company}:${user}`;
type Saved = { status?: PersonalStatus; kind?: string; client?: string };
function readSaved(key: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

/**
 * Radar › Pessoal: a MAVI Assistente Pessoal lê os grupos de WhatsApp dos
 * clientes em que a pessoa está e lista as situações que cabem a ela — com o
 * motivo, as falas e se o time já resolveu no grupo. Só leitura: nada sai
 * para o grupo. Quem lidera vê a lista do liderado (só leitura). A lista se
 * atualiza sozinha pelo aviso do Realtime (kind "personal_radar").
 */
export function PersonalRadarPage({
  company,
  user,
  notify,
}: {
  company: string;
  user: string;
  notify: (message: string) => void;
}) {
  const key = savedKey(company, user);
  const initial = useMemo(() => readSaved(key), [key]);
  const [state, setState] = useState<PersonalState | null>(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const [status, setStatus] = useState<PersonalStatus>(
    initial.status ?? "open",
  );
  const [kind, setKind] = useState(initial.kind ?? ALL);
  const [client, setClient] = useState(initial.client ?? ALL);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [list, setList] = useState<PersonalList | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    loadState(company)
      .then(setState)
      .catch((e) => setError((e as Error).message));
  }, [company]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ status, kind, client }));
    } catch {
      /* sem armazenamento: só não fica guardado */
    }
  }, [key, status, kind, client]);
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const active = !!state?.active;
  const viewable = !!state?.viewable.length;
  const show = active || (viewable && !!viewing);
  const filters: PersonalFilters = useMemo(
    () => ({
      status,
      kind: kind === ALL ? "" : (kind as PersonalKind),
      client: client === ALL ? "" : client,
      q,
      limit: PAGE,
    }),
    [status, kind, client, q],
  );
  const load = useCallback(
    (offset = 0) => {
      if (!show) return;
      const n = ++request.current;
      setBusy(true);
      loadList(company, viewing, { ...filters, offset })
        .then((r) => {
          if (n !== request.current) return;
          setList((prev) =>
            offset && prev ? { ...r, items: [...prev.items, ...r.items] } : r,
          );
          setError("");
        })
        .catch((e) => n === request.current && setError((e as Error).message))
        .finally(() => n === request.current && setBusy(false));
    },
    [company, viewing, filters, show],
  );
  useEffect(() => load(0), [load]);
  // As respostas que faltam: a MAVI escreve uma por vez (a fila é do banco).
  useEffect(() => {
    if (active && !viewing) void drainDrafts(company);
  }, [active, viewing, company]);
  // Sem consulta periódica: o banco avisa quando a lista de alguém muda.
  useEffect(() => {
    const target = viewing ?? user;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (e: Event) => {
      const people = (e as CustomEvent<{ people?: string[] }>).detail?.people;
      if (people && !people.includes(target)) return;
      clearTimeout(timer);
      timer = setTimeout(() => load(0), 400);
    };
    window.addEventListener("mavi:personal-radar", onChange);
    return () => {
      window.removeEventListener("mavi:personal-radar", onChange);
      clearTimeout(timer);
    };
  }, [load, viewing, user]);

  if (error && !state) return <p className="form-error">{error}</p>;
  if (!state) return <Loading variant="table" />;
  if (!state.whatsapp)
    return (
      <Empty
        title="WhatsApp não conectado"
        body="O Radar pessoal lê os grupos de WhatsApp dos clientes. Conecte o número da agência em Equipe e configurações › WhatsApp."
      />
    );

  const readOnly = !!viewing;
  const viewingName = state.viewable.find((p) => p.id === viewing)?.name;
  const changeItem = (item: PersonalItem) =>
    setList((l) =>
      l
        ? {
            ...l,
            items: l.items.map((i) =>
              i.id === item.id ? { ...i, ...item } : i,
            ),
          }
        : l,
    );

  return (
    <div className="pradar">
      {viewable && (
        <div className="pradar-viewing">
          <Users size={15} aria-hidden="true" />
          <span>Ver a lista de</span>
          <span className="thermo-filter">
            <Select
              aria-label="Ver a lista de"
              value={viewing ?? user}
              onValueChange={(v) => {
                setViewing(v === user ? null : v);
                setList(null);
              }}
            >
              <SelectOption value={user}>Você</SelectOption>
              {state.viewable.map((p) => (
                <SelectOption key={p.id} value={p.id}>
                  {p.name}
                </SelectOption>
              ))}
            </Select>
          </span>
          {readOnly && <span className="pradar-readonly">Só leitura</span>}
        </div>
      )}

      {!show ? (
        <Setup
          company={company}
          state={state}
          onSaved={(s) => {
            setState(s);
            if (s.active)
              notify(
                "Radar pessoal ligado. A MAVI começa a ler os seus grupos.",
              );
          }}
        />
      ) : (
        <>
          <section className="pradar-head" aria-label="Situações">
            <nav className="pradar-tabs" aria-label="Situação">
              {(
                [
                  ["open", "Em aberto"],
                  ["resolved", "Resolvidas"],
                  ["dismissed", "Descartadas"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={status === value}
                  className={status === value ? "selected" : ""}
                  onClick={() => setStatus(value)}
                >
                  {label}
                  <span className="pradar-count">
                    {list ? list.counts[value] : "–"}
                  </span>
                </button>
              ))}
            </nav>
          </section>
          <div className="thermo-filters pradar-filters">
            <span className="thermo-search">
              <Input
                type="search"
                aria-label="Buscar"
                placeholder="Buscar no título, no resumo ou pelo cliente"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
            <span className="thermo-filter">
              <Select aria-label="Tipo" value={kind} onValueChange={setKind}>
                <SelectOption value={ALL}>Todos os tipos</SelectOption>
                {(Object.keys(KIND_LABEL) as PersonalKind[]).map((k) => (
                  <SelectOption key={k} value={k}>
                    {KIND_LABEL[k]}
                  </SelectOption>
                ))}
              </Select>
            </span>
            <span className="thermo-filter">
              <Select
                aria-label="Cliente"
                value={client}
                onValueChange={setClient}
              >
                <SelectOption value={ALL}>Todos os clientes</SelectOption>
                {(list?.clients ?? [])
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((c) => (
                    <SelectOption key={c.id} value={c.id}>
                      {c.name}
                    </SelectOption>
                  ))}
              </Select>
            </span>
            <div className="thermo-filters-actions">
              <Button
                className="icon-btn"
                onClick={() => load(0)}
                loading={busy}
                aria-label="Atualizar"
                title="Atualizar"
              >
                <RefreshCw size={15} />
              </Button>
              <Button
                className="btn secondary"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 size={15} aria-hidden="true" /> Configurar
              </Button>
            </div>
          </div>
          {!readOnly && <Status state={state} />}
          {error && <p className="form-error">{error}</p>}
          {!list ? (
            <Loading variant="list" />
          ) : list.items.length === 0 ? (
            <Empty
              title={
                status === "open"
                  ? readOnly
                    ? `Nada em aberto para ${viewingName ?? "esta pessoa"}`
                    : "Nada em aberto para você"
                  : status === "resolved"
                    ? "Nenhuma situação resolvida"
                    : "Nada descartado"
              }
              body={
                status === "open"
                  ? "Quando um cliente pedir, perguntar ou reclamar de algo que é com você nos grupos, a MAVI lista aqui."
                  : "Ajuste a busca ou os filtros."
              }
            />
          ) : (
            <ul className="pradar-list">
              {list.items.map((i) => (
                <ItemCard
                  key={i.id}
                  company={company}
                  item={i}
                  readOnly={readOnly}
                  onChanged={(next, message) => {
                    changeItem(next);
                    if (message) notify(message);
                    // Sai da aba em que estava: recarrega as contagens.
                    load(0);
                  }}
                />
              ))}
            </ul>
          )}
          {list && list.items.length < list.total && (
            <div className="pradar-more">
              <Button
                className="btn secondary"
                onClick={() => load(list.items.length)}
                loading={busy}
              >
                Carregar mais ({list.total - list.items.length})
              </Button>
            </div>
          )}
        </>
      )}
      {settingsOpen && (
        <SettingsModal
          company={company}
          state={state}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s, message) => {
            setState(s);
            notify(message);
          }}
        />
      )}
    </div>
  );
}

/** Antes de ligar: o que é, o que é com a pessoa e o aviso de celular. */
function Setup({
  company,
  state,
  onSaved,
}: {
  company: string;
  state: PersonalState;
  onSaved: (s: PersonalState) => void;
}) {
  const [about, setAbout] = useState(state.about);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!state.allowed)
    return (
      <Empty
        title="O Radar pessoal ainda não foi liberado para você"
        body="Peça a um administrador para ligar o módulo Radar pessoal para você em Equipe e configurações › Pessoas › Módulos."
      />
    );
  const turnOn = () => {
    setBusy(true);
    setError("");
    saveState(company, true, about)
      .then(onSaved)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <section className="pradar-setup">
      <div className="pradar-setup-mark" aria-hidden="true">
        <Radar size={26} />
      </div>
      <h2>A MAVI como sua assistente nos grupos dos clientes</h2>
      <p>
        A MAVI lê os grupos de WhatsApp dos clientes em que você está e separa o
        que é com você: dúvidas, pedidos, reclamações, materiais enviados,
        aprovações e cobranças de prazo. Ela junta as repetições ("cobrou 3x") e
        tira da lista o que o time já resolveu no grupo.
      </p>
      <ul className="pradar-setup-points">
        <li>
          <EyeOff size={15} aria-hidden="true" /> Só leitura: a MAVI nunca
          escreve no grupo.
        </li>
        <li>
          <MessageCircle size={15} aria-hidden="true" />{" "}
          {state.groups === 1 ? "1 grupo seu" : `${state.groups} grupos seus`}{" "}
          hoje, lidos a cada {state.settings.interval_minutes} minutos. Na
          primeira vez, ela lê os últimos {state.settings.history_days} dias.
        </li>
        <li>
          <Sparkles size={15} aria-hidden="true" /> Ela aprende com o que você
          descarta e diz que não é com você.
        </li>
      </ul>
      {state.phones === 0 && (
        <p className="pradar-warn" role="status">
          <Info size={15} aria-hidden="true" /> Cadastre o seu celular em{" "}
          <a
            href={appPath("/perfil")}
            onClick={(e) => {
              e.preventDefault();
              openInApp("/perfil");
            }}
          >
            Meu perfil
          </a>{" "}
          para a MAVI saber em quais grupos você está.
        </p>
      )}
      <label className="pradar-field">
        <span>O que é com você</span>
        <Textarea
          value={about}
          maxLength={1500}
          rows={3}
          placeholder="Ex.: Sou gestor de tráfego: campanhas, verba, CPL e relatórios. Artes são com a Duda."
          onChange={(e) => setAbout(e.target.value)}
        />
        <small>
          A MAVI usa isso, junto com as suas equipes, para saber o que é com
          você quando ninguém te marca.
        </small>
      </label>
      {error && <p className="form-error">{error}</p>}
      <Button className="btn primary" onClick={turnOn} loading={busy}>
        <Radar size={16} aria-hidden="true" /> Ligar meu Radar pessoal
      </Button>
    </section>
  );
}

/** A linha de quanto a MAVI está lendo e quanto custou no mês. */
function Status({ state }: { state: PersonalState }) {
  const pct =
    state.cap > 0 ? Math.min(100, (state.spent / state.cap) * 100) : 100;
  return (
    <p className="pradar-status">
      <span>
        Lendo {state.groups === 1 ? "1 grupo" : `${state.groups} grupos`} · a
        cada {state.settings.interval_minutes} min
      </span>
      <span
        className={`pradar-cap${pct >= 100 ? " full" : pct >= 80 ? " near" : ""}`}
        title="Gasto da MAVI no seu Radar pessoal neste mês"
      >
        <span className="pradar-cap-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
        {usd(state.spent)} de {usd(state.cap)} no mês
        {pct >= 100 && " · teto atingido: a leitura volta no próximo mês"}
      </span>
    </p>
  );
}

function ItemCard({
  company,
  item,
  readOnly,
  onChanged,
}: {
  company: string;
  item: PersonalItem;
  readOnly: boolean;
  onChanged: (item: PersonalItem, message?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState<DismissReason>("not_mine");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mentions = item.mentions ?? [];
  const shown = expanded ? mentions : mentions.slice(-2);
  const run = (
    action: Parameters<typeof act>[2],
    message: string,
    text = "",
  ) => {
    setBusy(true);
    setError("");
    act(company, item.id, action, text)
      .then((next) => {
        setDismissing(false);
        onChanged(next, message);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const closed = item.status === "resolved" || item.state === "dismissed";
  const ReasonIcon =
    item.reason === "mention"
      ? AtSign
      : item.reason === "reply"
        ? CornerDownRight
        : Tag;
  return (
    <li className={`pradar-item kind-${item.kind}${closed ? " closed" : ""}`}>
      <div className="pradar-item-top">
        <span className={`pradar-kind kind-${item.kind}`}>
          {KIND_LABEL[item.kind]}
        </span>
        {item.urgency >= 2 && item.status === "open" && (
          <span className={`pradar-urgency u${item.urgency}`}>
            {URGENCY_LABEL[item.urgency]}
          </span>
        )}
        {item.asks > 1 && (
          <span className="pradar-asks">Cobrou {item.asks}x</span>
        )}
        {item.reopened_at && item.status === "open" && (
          <span className="pradar-asks">Voltou ao assunto</span>
        )}
        <span className="pradar-where">
          <strong>{item.client.name}</strong> · {item.group.title}
        </span>
        <time className="pradar-when" dateTime={item.last_at}>
          {whenBr(item.last_at)}
        </time>
      </div>
      <h3>{item.title}</h3>
      {item.summary && <p className="pradar-summary">{item.summary}</p>}
      <p className="pradar-reason">
        <ReasonIcon size={13} aria-hidden="true" />
        <span>{item.why || REASON_LABEL[item.reason]}</span>
        {!!item.others?.length && (
          <span className="muted"> · também com {item.others.join(", ")}</span>
        )}
      </p>
      {shown.length > 0 && (
        <ul className="pradar-quotes">
          {shown.map((m) => (
            <li key={m.message_id} className={m.role}>
              <span className="pradar-quote-who">
                {m.speaker}
                <span className="muted"> · {whenBr(m.at)}</span>
              </span>
              <q>{m.quote}</q>
            </li>
          ))}
        </ul>
      )}
      {(mentions.length > 2 || expanded) && (
        <button
          type="button"
          className="pradar-link"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? "Menos falas" : `Mais falas (${mentions.length - 2})`}
        </button>
      )}
      {expanded && item.mention_count > mentions.length && (
        <p className="pradar-more-note muted">
          E mais {item.mention_count - mentions.length}{" "}
          {item.mention_count - mentions.length === 1 ? "fala" : "falas"} no grupo.
        </p>
      )}
      {(item.reply || (!closed && !readOnly)) && (
        <ReplyPanel
          company={company}
          item={item}
          readOnly={readOnly || closed}
          onChanged={onChanged}
        />
      )}
      {closed && (
        <p className="pradar-resolved">
          <CheckCircle2 size={14} aria-hidden="true" />
          {item.state === "dismissed"
            ? `Descartado: ${DISMISS_LABEL[item.dismissed_reason ?? "other"].toLowerCase()}`
            : resolvedLine(item)}
        </p>
      )}
      <div className="pradar-item-links">
        <a
          href={appPath(
            messagePath(
              item.group.id,
              mentions[mentions.length - 1]?.message_id,
            ),
          )}
          onClick={(e) => {
            e.preventDefault();
            openInApp(
              messagePath(
                item.group.id,
                mentions[mentions.length - 1]?.message_id,
              ),
            );
          }}
        >
          <ExternalLink size={13} aria-hidden="true" /> Abrir no grupo
        </a>
        {item.task && (
          <a
            href={appPath(taskUrl(item.task, ""))}
            onClick={(e) => {
              e.preventDefault();
              navigate(appPath(taskUrl(item.task!, "")));
            }}
          >
            <CheckCircle2 size={13} aria-hidden="true" /> Tarefa:{" "}
            {item.task.title}
          </a>
        )}
        {item.radar && (
          <a
            href={appPath(`/radar?item=${item.radar.id}`)}
            onClick={(e) => {
              e.preventDefault();
              openInApp(`/radar?item=${item.radar!.id}`);
            }}
          >
            <Radar size={13} aria-hidden="true" /> Radar do cliente:{" "}
            {item.radar.title}
          </a>
        )}
      </div>
      {!readOnly && (
        <div className="pradar-actions">
          {closed ? (
            <Button
              className="btn secondary compact"
              onClick={() => run("reopened", "Situação reaberta.")}
              loading={busy}
            >
              <RotateCcw size={14} aria-hidden="true" /> Reabrir
            </Button>
          ) : (
            <>
              <Button
                className="btn secondary compact"
                onClick={() => run("resolved", "Marcado como resolvido.")}
                loading={busy && !dismissing}
              >
                <CheckCircle2 size={14} aria-hidden="true" /> Resolvido
              </Button>
              <Button
                className="btn quiet compact"
                onClick={() => setDismissing((v) => !v)}
                aria-expanded={dismissing}
              >
                <EyeOff size={14} aria-hidden="true" /> Descartar
              </Button>
            </>
          )}
        </div>
      )}
      {dismissing && !closed && (
        <div className="pradar-dismiss">
          <fieldset>
            <legend>Por que sair da sua lista?</legend>
            {(Object.keys(DISMISS_LABEL) as DismissReason[]).map((r) => (
              <label key={r}>
                <input
                  type="radio"
                  name={`dismiss-${item.id}`}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                />
                {DISMISS_LABEL[r]}
              </label>
            ))}
          </fieldset>
          <Textarea
            rows={2}
            maxLength={1000}
            value={note}
            placeholder="Se quiser, explique para a MAVI acertar da próxima vez (ex.: artes são com a Duda)."
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="pradar-actions">
            <Button
              className="btn primary compact"
              loading={busy}
              onClick={() =>
                run(
                  reason,
                  reason === "already_resolved"
                    ? "Marcado como resolvido."
                    : "Tirado da sua lista. A MAVI vai levar isso em conta.",
                  note,
                )
              }
            >
              Confirmar
            </Button>
            <Button
              className="btn secondary compact"
              onClick={() => setDismissing(false)}
              disabled={busy}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </li>
  );
}

/** Meu Radar (o que é comigo, ligar/desligar), o ritmo (líderes) e o teto (administradores). */
function SettingsModal({
  company,
  state,
  onClose,
  onSaved,
}: {
  company: string;
  state: PersonalState;
  onClose: () => void;
  onSaved: (s: PersonalState, message: string) => void;
}) {
  const [about, setAbout] = useState(state.about);
  const [every, setEvery] = useState(String(state.settings.interval_minutes));
  const [history, setHistory] = useState(String(state.settings.history_days));
  const [cap, setCap] = useState(String(state.settings.monthly_cap_usd));
  const [people, setPeople] = useState<PersonalPerson[] | null>(null);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!state.can_configure) return;
    loadPeople(company)
      .then((p) => {
        setPeople(p);
        setCaps(
          Object.fromEntries(
            p.map((x) => [x.id, x.cap_usd === null ? "" : String(x.cap_usd)]),
          ),
        );
      })
      .catch((e) => setError((e as Error).message));
  }, [company, state.can_configure]);
  const wrap = (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    work()
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const saveMine = (active: boolean) =>
    wrap(async () => {
      const s = await saveState(company, active, about);
      onSaved(
        s,
        active
          ? "Radar pessoal salvo."
          : "Radar pessoal desligado. A MAVI parou de ler os seus grupos.",
      );
      if (!active) onClose();
    });
  const saveCompany = () =>
    wrap(async () => {
      const num = (v: string) => Number(v.replace(",", "."));
      const s = await saveSettings(
        company,
        num(every),
        state.can_configure ? num(history) : null,
        state.can_configure ? num(cap) : null,
      );
      if (state.can_configure && people)
        for (const p of people) {
          const v = caps[p.id]?.trim() ?? "";
          const next = v === "" ? null : num(v);
          if (next !== p.cap_usd) await savePersonCap(company, p.id, next);
        }
      onSaved(s, "Configuração do Radar pessoal salva.");
    });
  return (
    <Modal
      title="Configurar o Radar pessoal"
      onClose={onClose}
      busy={busy}
      className="pradar-modal"
    >
      <div className="entity-form pradar-settings">
        {state.allowed && (
          <section>
            <h3>Meu Radar</h3>
            <label className="pradar-field">
              <span>O que é com você</span>
              <Textarea
                value={about}
                rows={3}
                maxLength={1500}
                onChange={(e) => setAbout(e.target.value)}
              />
              <small>
                A MAVI usa isso, junto com as suas equipes, para saber o que é
                com você quando ninguém te marca.
              </small>
            </label>
            <div className="pradar-actions">
              <Button
                className="btn primary"
                onClick={() => saveMine(true)}
                loading={busy}
              >
                {state.active ? "Salvar" : "Salvar e ligar"}
              </Button>
              {state.active && (
                <Button
                  className="btn secondary"
                  onClick={() => saveMine(false)}
                  disabled={busy}
                >
                  Desligar meu Radar pessoal
                </Button>
              )}
            </div>
          </section>
        )}
        {state.can_interval && (
          <section>
            <h3>Para a agência</h3>
            <div className="pradar-grid">
              <label className="pradar-field">
                <span>Ler os grupos a cada</span>
                <Select
                  aria-label="Ler os grupos a cada"
                  value={every}
                  onValueChange={setEvery}
                >
                  {[5, 10, 15, 20, 30, 45, 60].map((m) => (
                    <SelectOption key={m} value={String(m)}>
                      {m} minutos
                    </SelectOption>
                  ))}
                </Select>
              </label>
              {state.can_configure && (
                <>
                  <label className="pradar-field">
                    <span>Histórico ao ligar (dias)</span>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={history}
                      onChange={(e) => setHistory(e.target.value)}
                    />
                  </label>
                  <label className="pradar-field">
                    <span>Teto por pessoa por mês (US$)</span>
                    <Input
                      type="number"
                      min={0}
                      max={1000}
                      step="0.5"
                      value={cap}
                      onChange={(e) => setCap(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
            <small className="muted">
              Com alguém usando, a coleta do WhatsApp roda nesse ritmo (sem
              ninguém, a cada hora). Mais frequente custa mais leituras da MAVI.
            </small>
            {state.can_configure && people && (
              <table className="pradar-people">
                <thead>
                  <tr>
                    <th>Pessoa</th>
                    <th>Situação</th>
                    <th>Grupos</th>
                    <th>Gasto no mês</th>
                    <th>Teto próprio (US$)</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>
                        {!p.allowed
                          ? "Não liberado"
                          : p.active
                            ? "Ligado"
                            : p.started_at
                              ? "Desligado"
                              : "Liberado, não ligou"}
                        {p.phones === 0 && (
                          <span className="pradar-hint"> · sem celular</span>
                        )}
                      </td>
                      <td>{p.groups}</td>
                      <td>
                        {usd(p.spent)} / {usd(p.cap)}
                      </td>
                      <td>
                        <Input
                          type="number"
                          min={0}
                          max={1000}
                          step="0.5"
                          aria-label={`Teto próprio de ${p.name}`}
                          placeholder="Padrão"
                          value={caps[p.id] ?? ""}
                          onChange={(e) =>
                            setCaps((c) => ({ ...c, [p.id]: e.target.value }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {state.can_configure && (
              <small className="muted">
                Quem pode usar: Equipe e configurações › Pessoas › Módulos
                (Radar pessoal). Gestores e administradores já têm, salvo se
                ocultado.
              </small>
            )}
            <div className="pradar-actions">
              <Button
                className="btn primary"
                onClick={saveCompany}
                loading={busy}
              >
                Salvar para a agência
              </Button>
            </div>
          </section>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * A resposta que a MAVI daria: o texto (editável) para colar no WhatsApp, os
 * links que ela criaria (a pessoa cria aqui, se quiser), o que conferir e as
 * evidências. Copiar = aprovar (com edição, o texto final vai junto);
 * Refazer, Reprovar e Ensinar a MAVI ficam no aprendizado dela.
 */
function ReplyPanel({
  company,
  item,
  readOnly,
  onChanged,
}: {
  company: string;
  item: PersonalItem;
  readOnly: boolean;
  onChanged: (item: PersonalItem, message?: string) => void;
}) {
  const reply = item.reply;
  const base = reply?.approved_text ?? reply?.text ?? "";
  const [text, setText] = useState(base);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [linking, setLinking] = useState<string | null>(null);
  const [mode, setMode] = useState<null | "redo" | "reject" | "teach">(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<RejectReason>("wrong_info");
  const [showEvidence, setShowEvidence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = reply?.version ?? 0;
  // Uma versão nova da MAVI troca o texto (a edição da anterior fica no aprendizado).
  useEffect(() => {
    setText(base);
    setLinks({});
  }, [version, item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const write = (opts: { force?: boolean; guidance?: string } = {}) => {
    setBusy(true);
    setError("");
    requestDraft(company, item.id, opts)
      .then((r) => {
        setMode(null);
        setNote("");
        if (r.item) onChanged(r.item, "A MAVI escreveu uma nova resposta.");
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  if (!reply || reply.status === "pending")
    return (
      <div className="pradar-reply waiting">
        <Sparkles size={14} aria-hidden="true" />
        <span>A MAVI ainda não escreveu a resposta.</span>
        {!readOnly && (
          <Button className="btn secondary compact" onClick={() => write()} loading={busy}>
            Escrever agora
          </Button>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    );
  if (reply.status === "running")
    return (
      <div className="pradar-reply waiting" role="status">
        <Sparkles size={14} aria-hidden="true" className="pradar-pulse" />
        <span>A MAVI está escrevendo a resposta: lendo o cliente, as reuniões e as campanhas…</span>
      </div>
    );
  if (reply.status === "failed" && !reply.text)
    return (
      <div className="pradar-reply waiting">
        <span>A MAVI não conseguiu escrever a resposta{reply.error ? `: ${reply.error}` : "."}</span>
        {!readOnly && (
          <Button className="btn secondary compact" onClick={() => write({ force: true })} loading={busy}>
            Tentar de novo
          </Button>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    );

  const filled = fillLinks(text, links);
  const missing = pendingKeys(filled);
  const original = fillLinks(reply.text ?? "", links);
  const copy = () => {
    // Os marcadores sem link criado saem do texto copiado.
    const final = missing.reduce((t, k) => t.replaceAll(`{{${k}}}`, ""), filled).replace(/[ \t]{2,}/g, " ").trim();
    void navigator.clipboard?.writeText(final).catch(() => {});
    const edited = final !== original.trim() && final !== (reply.approved_text ?? "").trim();
    setBusy(true);
    setError("");
    replyFeedback(company, item.id, edited ? "edited" : "approved", edited ? final : "")
      .then((next) =>
        onChanged(next, edited ? "Copiado com as suas edições. A MAVI vai aprender com elas." : "Copiado. Cole no grupo do cliente."),
      )
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const makeLink = async (key: string) => {
    const a = reply.actions.find((x) => x.key === key);
    if (!a) return;
    setLinking(key);
    setError("");
    try {
      const url = await createLink(company, a);
      setLinks((l) => ({ ...l, [key]: url }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinking(null);
    }
  };
  const sendFeedback = () => {
    setBusy(true);
    setError("");
    replyFeedback(company, item.id, mode === "reject" ? "rejected" : "training", note, mode === "reject" ? reason : null)
      .then((next) => {
        setMode(null);
        setNote("");
        onChanged(next, mode === "reject" ? "Resposta reprovada. A MAVI vai levar isso em conta." : "Anotado. A MAVI segue isso daqui para a frente.");
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const rejected = reply.status === "rejected";
  return (
    <div className={`pradar-reply${rejected ? " rejected" : ""}`}>
      <div className="pradar-reply-head">
        <span className="pradar-reply-title">
          <Sparkles size={14} aria-hidden="true" /> Resposta sugerida pela MAVI
        </span>
        {reply.confidence && (
          <span className={`pradar-confidence c-${reply.confidence}`}>{CONFIDENCE_LABEL[reply.confidence]}</span>
        )}
        {version > 1 && <span className="muted">versão {version}</span>}
        {reply.approved_at && (
          <span className="pradar-approved">
            <CheckCircle2 size={13} aria-hidden="true" /> Copiada {whenBr(reply.approved_at)}
          </span>
        )}
        {rejected && <span className="pradar-rejected">Reprovada</span>}
      </div>
      {reply.stale && !readOnly && (
        <p className="pradar-warn">
          <Info size={14} aria-hidden="true" /> O cliente falou de novo depois desta resposta.{" "}
          <button type="button" className="pradar-link" onClick={() => write({ force: true })} disabled={busy}>
            Atualizar a resposta
          </button>
        </p>
      )}
      {readOnly ? (
        <p className="pradar-reply-text">{filled}</p>
      ) : (
        <Textarea
          className="pradar-reply-input"
          aria-label="Resposta para o grupo"
          value={filled}
          rows={Math.min(10, Math.max(3, Math.ceil(filled.length / 90)))}
          maxLength={6000}
          onChange={(e) => {
            // O link criado volta a ser marcador na edição (a próxima troca põe de novo).
            let next = e.target.value;
            for (const [k, url] of Object.entries(links)) next = next.replaceAll(url, `{{${k}}}`);
            setText(next);
          }}
        />
      )}
      {reply.actions.length > 0 && (
        <ul className="pradar-reply-actions">
          {reply.actions.map((a) => (
            <li key={a.key}>
              <span className="pradar-key">{`{{${a.key}}}`}</span>
              <span className="pradar-action-label">{a.label}</span>
              {links[a.key] ? (
                <a href={links[a.key]} target="_blank" rel="noreferrer" className="pradar-link-ok">
                  <CheckCircle2 size={13} aria-hidden="true" /> Link criado
                </a>
              ) : readOnly ? (
                <span className="muted">link sugerido</span>
              ) : (
                <Button className="btn secondary compact" onClick={() => makeLink(a.key)} loading={linking === a.key} disabled={!!linking}>
                  Criar link
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {reply.checks.length > 0 && (
        <ul className="pradar-checks">
          {reply.checks.map((c, n) => (
            <li key={n}>
              <Info size={13} aria-hidden="true" /> {c}
            </li>
          ))}
        </ul>
      )}
      {reply.evidence.length > 0 && (
        <>
          <button type="button" className="pradar-link" onClick={() => setShowEvidence((v) => !v)}>
            {showEvidence ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            Evidências ({reply.evidence.length})
          </button>
          {showEvidence && (
            <ul className="pradar-evidence">
              {reply.evidence.map((e, n) => (
                <li key={n}>
                  <strong>{e.title}</strong>
                  {e.detail && <span>{e.detail}</span>}
                  {e.source && (
                    <a
                      href={sourceUrl(e.source)}
                      onClick={(ev) => {
                        ev.preventDefault();
                        navigate(sourceUrl(e.source!));
                      }}
                    >
                      <ExternalLink size={12} aria-hidden="true" /> {e.source.title}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {!readOnly && (
        <div className="pradar-actions">
          <Button className="btn primary compact" onClick={copy} loading={busy && !mode}>
            <Copy size={14} aria-hidden="true" /> {missing.length ? "Copiar sem os links" : "Copiar"}
          </Button>
          <Button className="btn quiet compact" onClick={() => setMode(mode === "redo" ? null : "redo")} aria-expanded={mode === "redo"}>
            <RotateCcw size={14} aria-hidden="true" /> Refazer
          </Button>
          <Button className="btn quiet compact" onClick={() => setMode(mode === "reject" ? null : "reject")} aria-expanded={mode === "reject"}>
            <ThumbsDown size={14} aria-hidden="true" /> Reprovar
          </Button>
          <Button className="btn quiet compact" onClick={() => setMode(mode === "teach" ? null : "teach")} aria-expanded={mode === "teach"}>
            <GraduationCap size={14} aria-hidden="true" /> Ensinar a MAVI
          </Button>
        </div>
      )}
      {mode && (
        <div className="pradar-dismiss">
          {mode === "reject" && (
            <fieldset>
              <legend>O que está errado?</legend>
              {(Object.keys(REJECT_LABEL) as RejectReason[]).map((r) => (
                <label key={r}>
                  <input type="radio" name={`reject-${item.id}`} checked={reason === r} onChange={() => setReason(r)} />
                  {REJECT_LABEL[r]}
                </label>
              ))}
            </fieldset>
          )}
          <Textarea
            rows={2}
            maxLength={2000}
            value={note}
            placeholder={
              mode === "redo"
                ? "O que mudar nesta resposta? (ex.: mais curta, cite o relatório de setembro)"
                : mode === "reject"
                  ? "Se quiser, explique (ex.: o CPL certo é de R$ 13)."
                  : "O que a MAVI deve fazer sempre? (ex.: chame o cliente pelo primeiro nome e não use emojis)"
            }
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="pradar-actions">
            <Button
              className="btn primary compact"
              loading={busy}
              disabled={mode === "teach" && !note.trim()}
              onClick={() => (mode === "redo" ? write({ force: true, guidance: note.trim() }) : sendFeedback())}
            >
              {mode === "redo" ? "Escrever de novo" : mode === "reject" ? "Reprovar" : "Ensinar"}
            </Button>
            <Button className="btn secondary compact" onClick={() => setMode(null)} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      {reply.model && <p className="pradar-model muted">Escrita por {reply.model}</p>}
    </div>
  );
}

