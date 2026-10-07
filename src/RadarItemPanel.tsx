import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { AlertTriangle, ExternalLink, Layers, Link2, MessageCircle, Plus, RotateCcw, Trash2, Unlink, Video } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Modal } from "./components";
import { type Member, type Snapshot, type Task } from "./types";
import type { FormPreset } from "./forms";
import { appPath, openInApp } from "./temperature";
import { tasksByIds } from "./api";
import { buildNameLookup, dateKey } from "./domain";
import { TaskTable } from "./TaskTable";
import { RadarTaskPicker } from "./RadarTaskPicker";
import { AgentCheckCard, RemoveCaseForm } from "./RadarCaseTools";
import { removedMessage } from "./agent-check";
import {
  SEVERITY_COLORS,
  clock,
  dateBr,
  loadItem,
  loadItemExtras,
  occurrencePath,
  removeItem,
  linkTask,
  unlinkTask,
  overdue,
  radarTaskPreset,
  setItemTheme,
  severityName,
  statusOf,
  updateItem,
  type RadarItemDetail,
  type RadarItemExtras,
  type RadarPatch,
  type RadarTask,
  type ThemeMove,
} from "./radar";
import { recordTaskCreated } from "./radar-task-learning";

const NONE = "__none__";
const AUTO = "__auto__";
const NEW = "__new__";
const ROLE: Record<string, string> = { client: "cliente", team: "time", unknown: "não identificado" };
const UUID = /^[0-9a-f-]{36}$/i;
/**
 * Uma tarefa que a lista não trouxe (a demonstração, uma linha fora do
 * alcance da pessoa): o que o Radar sabe dela, com o produto do item.
 */
function stub(t: RadarTask, item: RadarItemDetail, members: Member[], data?: Snapshot) {
  const contract = data?.contracts.find((c) => c.client_id === item.client_id && c.product_id === item.product_id);
  const person = members.find((m) => m.name === t.assignee_name);
  return {
    ...t,
    company_id: "",
    contract_id: contract?.id ?? "",
    parent_id: null,
    assignee_id: person?.user_id ?? "",
    creator_id: "",
    priority: null,
  } as unknown as Task;
}

/**
 * Um item do Radar: o que a MAVI entendeu, o andamento (status,
 * responsável, gravidade, prazo, produto) e cada vez que o assunto apareceu,
 * com o trecho e o link para o momento da reunião ou a mensagem do grupo.
 * Quem edita o item muda o tema, cria tarefas a partir dele e vincula ou
 * desvincula tarefas que já existem; os demais (pela aba do cliente no
 * Drive) só leem. Também mostra a conferência com o robô do cliente
 * (Agente Conversacional) e, para administradores e gestores, excluir o caso
 * (migration 20270512090000).
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
  onRemoved,
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
  /** Uma tarefa ficou ligada ao item (ou deixou de ficar). */
  onTaskLinked?: (item: string) => void;
  /** O caso foi excluído (o painel fecha). */
  onRemoved?: (item: string) => void;
  notify?: (message: string) => void;
}) {
  const [item, setItem] = useState<RadarItemDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [newTheme, setNewTheme] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  // As tarefas do item como a lista de Tarefas as mostra (as colunas da lista).
  const [rows, setRows] = useState<Task[] | null>(null);
  const [extras, setExtras] = useState<RadarItemExtras>({});
  const [removing, setRemoving] = useState(false);
  const taskIds = item?.tasks.map((t) => t.id).join(",") ?? "";

  useEffect(() => {
    loadItem(company, itemId)
      .then((i) => {
        setItem(i);
        setTitle(i.title);
        setSummary(i.summary);
        setFields(i.fields ?? {});
      })
      .catch((e) => setError((e as Error).message));
    void loadItemExtras(company, itemId).then(setExtras);
  }, [company, itemId]);

  useEffect(() => {
    if (!item) return;
    const known = item.tasks;
    if (!known.length) {
      setRows([]);
      return;
    }
    let alive = true;
    // Na demonstração, as tarefas do exemplo; no banco, as linhas atuais.
    (UUID.test(company) ? tasksByIds(company, known.map((t) => t.id)) : Promise.resolve([] as Task[]))
      .catch(() => [] as Task[])
      .then((found) => {
        if (!alive) return;
        const byId = new Map([...(data?.tasks ?? []), ...found].map((t) => [t.id, t]));
        setRows(known.map((t) => byId.get(t.id) ?? stub(t, item, members, data)));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, taskIds]);
  const lookup = useMemo(() => (data ? buildNameLookup(data) : null), [data]);
  const today = dateKey(new Date(), data?.companies.find((c) => c.id === company)?.timezone);

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
    // No banco, liga e guarda o que veio preenchido: a MAVI aprende com o
    // que a pessoa escolheu e mudou (migration 20270605090000).
    onNewTask({
      ...preset,
      onCreated: (task) =>
        void (UUID.test(company) ? recordTaskCreated(company, id, task, preset) : linkTask(company, id, task))
          .then(() => {
            notify?.("Tarefa criada e ligada ao item do Radar. A MAVI aprende com o que você escolheu.");
            onTaskLinked?.(id);
          })
          .catch((e) => notify?.(`A tarefa foi criada, mas não ficou ligada ao item: ${(e as Error).message}`)),
    });
  }
  async function linkExisting(ids: string[]) {
    if (!item) return;
    await Promise.all(ids.map((t) => linkTask(company, item.id, t)));
    const next = await loadItem(company, item.id);
    setItem(next);
    setLinking(false);
    onTaskLinked?.(item.id);
    notify?.(ids.length > 1 ? `${ids.length} tarefas vinculadas ao item.` : "Tarefa vinculada ao item.");
  }
  async function unlink(task: string) {
    if (!item) return;
    setUnlinking(task);
    setError("");
    try {
      await unlinkTask(company, item.id, task);
      setItem(await loadItem(company, item.id));
      onTaskLinked?.(item.id);
      notify?.("Tarefa desvinculada do item. A tarefa continua como estava.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUnlinking(null);
    }
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
          {extras.agent_check && <AgentCheckCard check={extras.agent_check} notify={(m) => notify?.(m)} />}
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

          {extras.can_remove &&
            (removing ? (
              <RemoveCaseForm
                name={item.title}
                scope="Ele sai do Radar para todos."
                onCancel={() => setRemoving(false)}
                onConfirm={async (reason, note) => {
                  const r = await removeItem(company, item.id, reason, note);
                  notify?.(removedMessage(r));
                  onRemoved?.(item.id);
                  onClose();
                }}
              />
            ) : (
              <div>
                <Button className="btn quiet compact" onClick={() => setRemoving(true)}>
                  <Trash2 size={14} aria-hidden="true" /> Excluir caso
                </Button>
              </div>
            ))}
          {(item.tasks.length > 0 || edit) && (
            <div className="radar-tasks">
              <div className="radar-tasks-head">
                <h4 className="radar-occ-title">Tarefas</h4>
                {edit && (
                  <div className="radar-tasks-actions">
                    {lookup && (
                      <Button
                        className="btn secondary"
                        aria-expanded={linking}
                        onClick={() => setLinking((v) => !v)}
                      >
                        <Link2 size={14} aria-hidden="true" /> Vincular tarefa
                      </Button>
                    )}
                    {onNewTask && (
                      <Button className="btn secondary" onClick={createTask}>
                        <Plus size={14} aria-hidden="true" /> Criar tarefa
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {linking && lookup && (
                <RadarTaskPicker
                  company={company}
                  item={item}
                  lookup={lookup}
                  demoTasks={data?.tasks}
                  onCancel={() => setLinking(false)}
                  onLink={linkExisting}
                />
              )}
              {item.tasks.length ? (
                !rows || !lookup ? (
                  <Loading variant="list" />
                ) : (
                  <div className="radar-task-table">
                    <TaskTable
                      tasks={rows}
                      me={user}
                      lookup={lookup}
                      today={today}
                      onSelect={(id) => {
                        onClose();
                        openInApp(`/tarefas/${id}`);
                      }}
                      parentTitle={(id) => data?.tasks.find((t) => t.id === id)?.title}
                      rowAction={
                        edit
                          ? (t) => (
                              <Button
                                className="row-unlink"
                                loading={unlinking === t.id}
                                disabled={!!unlinking}
                                title="Desvincular do item (a tarefa não muda)"
                                aria-label={`Desvincular ${t.title} do item`}
                                onClick={() => void unlink(t.id)}
                              >
                                <Unlink size={13} aria-hidden="true" />
                              </Button>
                            )
                          : undefined
                      }
                    />
                  </div>
                )
              ) : (
                !linking && (
                  <p className="muted">
                    Nenhuma tarefa ainda. Vincule uma que já existe ou crie uma nova (ela já vem com as falas e o
                    link do item).
                  </p>
                )
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
