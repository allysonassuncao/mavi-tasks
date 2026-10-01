import { useEffect, useState, type CSSProperties } from "react";
import { AlertTriangle, CheckSquare, ExternalLink, Layers, MessageCircle, Plus, RotateCcw, Video } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Modal } from "./components";
import { statuses, type Member, type Snapshot, type Status } from "./types";
import type { FormPreset } from "./forms";
import { appPath, openInApp } from "./temperature";
import {
  SEVERITY_COLORS,
  clock,
  dateBr,
  loadItem,
  occurrencePath,
  linkTask,
  overdue,
  radarTaskPreset,
  setItemTheme,
  severityName,
  statusOf,
  updateItem,
  type RadarItemDetail,
  type RadarPatch,
  type ThemeMove,
} from "./radar";

const NONE = "__none__";
const AUTO = "__auto__";
const NEW = "__new__";
const ROLE: Record<string, string> = { client: "cliente", team: "time", unknown: "não identificado" };

/**
 * Um item do Radar: o que a MAVI entendeu, o andamento (status,
 * responsável, gravidade, prazo, produto) e cada vez que o assunto apareceu,
 * com o trecho e o link para o momento da reunião ou a mensagem do grupo.
 * Líderes editam, mudam o tema e criam tarefas a partir do item; os demais
 * (pela aba do cliente no Drive) só leem.
 */
export function RadarItemPanel({
  company,
  itemId,
  members,
  onClose,
  onChanged,
  data,
  user,
  onNewTask,
  onTaskLinked,
  notify,
}: {
  company: string;
  itemId: string;
  members: Member[];
  onClose: () => void;
  onChanged?: (item: RadarItemDetail) => void;
  /** Para criar a tarefa (o produto do cliente que a pessoa pode usar). */
  data?: Snapshot;
  user?: string;
  onNewTask?: (preset: FormPreset) => void;
  /** A tarefa criada pelo painel ficou ligada ao item. */
  onTaskLinked?: (item: string) => void;
  notify?: (message: string) => void;
}) {
  const [item, setItem] = useState<RadarItemDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [newTheme, setNewTheme] = useState<string | null>(null);

  useEffect(() => {
    loadItem(company, itemId)
      .then((i) => {
        setItem(i);
        setTitle(i.title);
        setSummary(i.summary);
        setFields(i.fields ?? {});
      })
      .catch((e) => setError((e as Error).message));
  }, [company, itemId]);

  async function save(patch: RadarPatch) {
    if (!item) return;
    await apply(() => updateItem(company, item.id, patch));
  }
  async function move(to: ThemeMove) {
    if (!item) return;
    await apply(() => setItemTheme(company, item.id, to));
    setNewTheme(null);
  }
  function createTask() {
    if (!item || !data || !user || !onNewTask) return;
    const preset = radarTaskPreset(item, data, user);
    if (!preset) {
      notify?.("Para criar a tarefa, você precisa ter acesso a um produto contratado deste cliente.");
      return;
    }
    const id = item.id;
    onClose();
    onNewTask({
      ...preset,
      onCreated: (task) =>
        void linkTask(company, id, task)
          .then(() => {
            notify?.("Tarefa criada e ligada ao item do Radar.");
            onTaskLinked?.(id);
          })
          .catch((e) => notify?.(`A tarefa foi criada, mas não ficou ligada ao item: ${(e as Error).message}`)),
    });
  }
  async function apply(fn: () => Promise<RadarItemDetail>) {
    setBusy(true);
    setError("");
    try {
      const next = await fn();
      setItem(next);
      setTitle(next.title);
      setSummary(next.summary);
      setFields(next.fields ?? {});
      onChanged?.(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const topic = item?.topic;
  const edit = !!item?.can_edit;
  const status = item && topic ? statusOf(topic, item.status) : null;
  const late = item && topic ? overdue(topic, item) : false;
  const people = members.filter((m) => m.active);

  return (
    <Modal title={item?.title ?? "Item do Radar"} onClose={onClose} wide busy={busy} className="radar-sheet">
      {!item || !topic ? (
        error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <Loading variant="detail" />
        )
      ) : (
        <div className="radar-detail">
          <div className="radar-detail-tags">
            <span className="radar-topic-tag" style={{ "--topic": topic.color } as CSSProperties}>
              {topic.name}
            </span>
            <span>{item.client_name}</span>
            <span className="muted">· {item.product_name ?? "Geral / Agência"}</span>
          </div>

          {edit ? (
            <label className="radar-detail-field wide">
              <span>Título</span>
              <Input
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title.trim() !== item.title && title.trim().length >= 3 && save({ title: title.trim() })}
              />
            </label>
          ) : (
            <h3 className="radar-detail-title">{item.title}</h3>
          )}
          {edit ? (
            <label className="radar-detail-field wide">
              <span>O que a MAVI entendeu</span>
              <Textarea
                rows={3}
                value={summary}
                maxLength={1500}
                onChange={(e) => setSummary(e.target.value)}
                onBlur={() => summary.trim() !== item.summary && save({ summary: summary.trim() })}
              />
            </label>
          ) : (
            item.summary && <p className="radar-detail-summary">{item.summary}</p>
          )}

          <div className="radar-detail-grid">
            <label className="radar-detail-field">
              <span>Status</span>
              {edit ? (
                <Select aria-label="Status" value={item.status} onValueChange={(v) => save({ status: v })}>
                  {topic.statuses.map((s) => (
                    <SelectOption key={s.key} value={s.key!}>
                      {s.label}
                    </SelectOption>
                  ))}
                </Select>
              ) : (
                <strong className="radar-status" style={{ "--status": status?.color ?? "#a3acab" } as CSSProperties}>
                  {status?.label ?? item.status}
                </strong>
              )}
            </label>
            <label className="radar-detail-field">
              <span>Responsável</span>
              {edit ? (
                <Select
                  aria-label="Responsável"
                  value={item.assignee_id ?? NONE}
                  onValueChange={(v) => save({ assignee_id: v === NONE ? null : v })}
                >
                  <SelectOption value={NONE}>Sem responsável</SelectOption>
                  {people.map((m) => (
                    <SelectOption key={m.user_id} value={m.user_id}>
                      {m.name}
                    </SelectOption>
                  ))}
                </Select>
              ) : (
                <strong>{item.assignee_name ?? "Sem responsável"}</strong>
              )}
            </label>
            {topic.severity && (
              <label className="radar-detail-field">
                <span>{topic.severity_label}</span>
                {edit ? (
                  <Select
                    aria-label={topic.severity_label}
                    value={item.severity === null ? NONE : String(item.severity)}
                    onValueChange={(v) => save({ severity: v === NONE ? null : Number(v) })}
                  >
                    <SelectOption value={NONE}>Sem {topic.severity_label.toLowerCase()}</SelectOption>
                    {topic.severity_levels.map((_, i) => (
                      <SelectOption key={i} value={String(i)}>
                        {severityName(topic, i)}
                      </SelectOption>
                    ))}
                  </Select>
                ) : (
                  <strong>{severityName(topic, item.severity) ?? "—"}</strong>
                )}
              </label>
            )}
            {topic.has_due && (
              <label className="radar-detail-field">
                <span>Prazo</span>
                {edit ? (
                  <Input
                    type="date"
                    value={item.due_date ?? ""}
                    onChange={(e) => save({ due_date: e.target.value || null })}
                  />
                ) : (
                  <strong>{item.due_date ? dateBr(item.due_date) : "Sem prazo"}</strong>
                )}
                {late && <small className="radar-late">Vencida</small>}
              </label>
            )}
            <label className="radar-detail-field">
              <span>Produto</span>
              {edit ? (
                <Select
                  aria-label="Produto"
                  value={item.product_id ?? NONE}
                  onValueChange={(v) => save({ product_id: v === NONE ? null : v })}
                >
                  <SelectOption value={NONE}>Geral / Agência</SelectOption>
                  {item.client_products.map((p) => (
                    <SelectOption key={p.id} value={p.id}>
                      {p.name}
                    </SelectOption>
                  ))}
                </Select>
              ) : (
                <strong>{item.product_name ?? "Geral / Agência"}</strong>
              )}
            </label>
            <label className="radar-detail-field">
              <span>Tema</span>
              {edit ? (
                <Select
                  aria-label="Tema"
                  value={newTheme !== null ? NEW : (item.theme_id ?? (item.theme_pending ? AUTO : NONE))}
                  onValueChange={(v) =>
                    v === NEW
                      ? setNewTheme("")
                      : v === AUTO
                        ? move({ auto: true })
                        : v === NONE
                          ? move({ none: true })
                          : move({ theme: v })
                  }
                >
                  <SelectOption value={AUTO}>
                    {item.theme_pending ? "A MAVI vai escolher" : "Deixar a MAVI escolher"}
                  </SelectOption>
                  <SelectOption value={NONE}>Sem tema</SelectOption>
                  {item.theme_options.map((t) => (
                    <SelectOption key={t.id} value={t.id}>
                      {t.title}
                    </SelectOption>
                  ))}
                  <SelectOption value={NEW}>Novo tema…</SelectOption>
                </Select>
              ) : (
                <strong>{item.theme_title ?? (item.theme_pending ? "A MAVI vai escolher" : "Sem tema")}</strong>
              )}
            </label>
            {newTheme !== null && (
              <div className="radar-detail-field wide radar-new-theme">
                <span>Nome do tema novo</span>
                <div>
                  <Input
                    autoFocus
                    value={newTheme}
                    maxLength={160}
                    placeholder="Ex.: Atraso na aprovação de criativos"
                    onChange={(e) => setNewTheme(e.target.value)}
                  />
                  <Button
                    className="btn primary"
                    disabled={newTheme.trim().length < 3}
                    onClick={() => move({ title: newTheme.trim() })}
                  >
                    <Layers size={14} aria-hidden="true" /> Criar tema
                  </Button>
                  <Button className="btn secondary" onClick={() => setNewTheme(null)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
            {topic.fields.map((f) => (
              <label className="radar-detail-field" key={f.key}>
                <span>{f.label}</span>
                {!edit ? (
                  <strong>{fields[f.key!] ? (f.type === "date" ? dateBr(fields[f.key!]) : fields[f.key!]) : "—"}</strong>
                ) : f.type === "choice" ? (
                  <Select
                    aria-label={f.label}
                    value={fields[f.key!] ?? NONE}
                    onValueChange={(v) => {
                      const next = { ...fields, [f.key!]: v === NONE ? "" : v };
                      setFields(next);
                      save({ fields: next });
                    }}
                  >
                    <SelectOption value={NONE}>—</SelectOption>
                    {f.options.map((o) => (
                      <SelectOption key={o} value={o}>
                        {o}
                      </SelectOption>
                    ))}
                  </Select>
                ) : (
                  <Input
                    type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                    value={fields[f.key!] ?? ""}
                    onChange={(e) => setFields({ ...fields, [f.key!]: e.target.value })}
                    onBlur={() => (fields[f.key!] ?? "") !== (item.fields?.[f.key!] ?? "") && save({ fields })}
                  />
                )}
              </label>
            ))}
          </div>

          <p className="radar-detail-meta">
            {item.mentions === 1 ? "Apareceu 1 vez" : `Apareceu ${item.mentions} vezes`}
            {item.mentions > 1 && ` · desde ${dateBr(item.first_seen_at)}`} · última em {dateBr(item.last_seen_at)}
            {item.reopened_at && (
              <>
                {" · "}
                <RotateCcw size={12} aria-hidden="true" /> reaberto em {dateBr(item.reopened_at)}
              </>
            )}
          </p>
          {!item.speaker_confirmed && (
            <p className="radar-unconfirmed">
              <AlertTriangle size={14} aria-hidden="true" />
              Quem falou não foi confirmado: a MAVI deduziu pelo contexto. Cadastre os celulares do time em
              Meu perfil para separar melhor cliente e time.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          {(item.tasks.length > 0 || (edit && onNewTask)) && (
            <div className="radar-tasks">
              <div className="radar-tasks-head">
                <h4 className="radar-occ-title">Tarefas</h4>
                {edit && onNewTask && (
                  <Button className="btn secondary" onClick={createTask}>
                    <Plus size={14} aria-hidden="true" /> Criar tarefa
                  </Button>
                )}
              </div>
              {item.tasks.length ? (
                <ul>
                  {item.tasks.map((t) => {
                    const st = statuses[t.status as Status];
                    return (
                      <li key={t.id}>
                        <a
                          href={appPath(`/tarefas/${t.id}`)}
                          onClick={(e) => {
                            e.preventDefault();
                            onClose();
                            openInApp(`/tarefas/${t.id}`);
                          }}
                        >
                          <CheckSquare size={14} aria-hidden="true" /> {t.title}
                        </a>
                        <small>
                          {st?.label ?? t.status}
                          {t.assignee_name && ` · ${t.assignee_name}`}
                          {t.due_date && ` · até ${dateBr(t.due_date)}`}
                        </small>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">Nenhuma tarefa ainda. A tarefa criada aqui já vem com as falas e o link do item.</p>
              )}
            </div>
          )}

          <h4 className="radar-occ-title">Onde apareceu</h4>
          <ol className="radar-occurrences">
            {item.occurrences.map((o) => {
              const path = occurrencePath(o);
              return (
                <li key={o.id}>
                  <span className="radar-occ-icon" aria-hidden="true">
                    {o.source_type === "meeting" ? <Video size={15} /> : <MessageCircle size={15} />}
                  </span>
                  <div>
                    <div className="radar-occ-head">
                      <strong>{o.title || (o.source_type === "meeting" ? "Reunião" : "WhatsApp")}</strong>
                      <small>
                        {dateBr(o.occurred_at)}
                        {o.source_type === "meeting" && o.at_seconds !== null && ` · ${clock(o.at_seconds)}`}
                      </small>
                    </div>
                    <blockquote>“{o.quote}”</blockquote>
                    <small className="radar-occ-who">
                      {o.speaker || "Sem nome"} · {ROLE[o.role] ?? o.role}
                    </small>
                  </div>
                  {path && (
                    <a
                      className="icon-btn"
                      href={appPath(path)}
                      title={o.source_type === "meeting" ? "Abrir a reunião neste momento" : "Abrir a mensagem"}
                      aria-label={o.source_type === "meeting" ? "Abrir a reunião neste momento" : "Abrir a mensagem"}
                      onClick={(e) => {
                        e.preventDefault();
                        onClose();
                        openInApp(path);
                      }}
                    >
                      <ExternalLink size={15} />
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Modal>
  );
}

/** A gravidade como selo pequeno (cor do nível). */
export function SeverityDot({
  topic,
  value,
}: {
  topic: { severity: boolean; severity_levels: string[]; severity_label: string };
  value: number | null;
}) {
  if (!topic.severity || value === null) return <span className="muted">—</span>;
  return (
    <span className="radar-sev" style={{ "--sev": SEVERITY_COLORS[value] } as CSSProperties}>
      {severityName(topic, value)}
    </span>
  );
}
