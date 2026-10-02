import * as Popover from "@radix-ui/react-popover";
import {
  ArrowDown,
  ArrowUp,
  CheckCheck,
  ChevronDown,
  CornerDownRight,
  EllipsisVertical,
  GripVertical,
  History,
  ListPlus,
  Lock,
  Pencil,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button, Checkbox, Select, SelectOption } from "./ui";
import {
  checklistAsItems,
  checklistLogLabel,
  checklistProgress,
  checklistTree,
  openChecklistItems,
  withItemDone,
} from "./checklist";
import {
  ChecklistTemplateEditor,
  saveChecklistTemplate,
} from "./ChecklistTemplates";
import type {
  ChecklistItem,
  ChecklistLogEntry,
  Snapshot,
  Task,
  TaskChecklist,
} from "./types";
import "./task-checklist.css";

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;
/** Runs a checklist function; resolves with the task's checklists after it. */
export type ChecklistRun = (
  name: string,
  args: Record<string, unknown>,
) => Promise<TaskChecklist[]>;

const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The task's "Checklist" side panel (migration 20270220090000): named
 * checklists with one level of subitems, created and filled right here.
 * Whoever sees the task adds and marks; renaming and deleting what someone
 * else wrote is for the task's creator and leaders. Everything is recorded
 * (the "Registro" at the bottom; the main lines also reach the Histórico).
 */
export function TaskChecklistPanel({
  task,
  data,
  user,
  company,
  lists,
  canManage,
  isLeader,
  run,
  mutate,
  notify,
  loadHistory,
  onLists,
}: {
  task: Task;
  data: Snapshot;
  user: string;
  company: string;
  lists: TaskChecklist[];
  /** The task's creator and leaders: rename/delete anything, the delivery rule. */
  canManage: boolean;
  /** Saves a checklist as a model. */
  isLeader: boolean;
  run: ChecklistRun;
  mutate: Mutate;
  notify: (message: string) => void;
  loadHistory: () => Promise<ChecklistLogEntry[]>;
  /** An optimistic change (a mark), before the database answers. */
  onLists: (lists: TaskChecklist[]) => void;
}) {
  const [error, setError] = useState("");
  const [creating, setCreating] = useState("");
  const [busy, setBusy] = useState(false);
  // A checklist just created: its "Adicionar item" gets the focus.
  const [focusList, setFocusList] = useState("");
  const [saving, setSaving] = useState<TaskChecklist | null>(null);
  const [showLog, setShowLog] = useState(false);
  const memberName = (id: string | null) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Usuário removido";
  const models = (data.checklistTemplates ?? [])
    .filter((t) => t.active)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const open = openChecklistItems(lists);
  const total = lists.reduce((n, l) => n + l.items.length, 0);
  const required = !!task.checklist_required;

  async function act(name: string, args: Record<string, unknown>) {
    setError("");
    try {
      return await run(name, args);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }
  async function createList(title = creating) {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const after = await act("add_task_checklist", {
        p_task: task.id,
        p_title: title.trim(),
        p_items: [],
      });
      setCreating("");
      setFocusList(after[after.length - 1]?.id ?? "");
    } catch {
      // Shown above.
    } finally {
      setBusy(false);
    }
  }
  async function applyModel(id: string) {
    if (!id) return;
    setBusy(true);
    try {
      await act("apply_checklist_templates", {
        p_task: task.id,
        p_templates: [id],
        p_required: null,
      });
      notify(
        `Checklist “${models.find((m) => m.id === id)?.name ?? ""}” adicionado.`,
      );
    } catch {
      // Shown above.
    } finally {
      setBusy(false);
    }
  }
  async function toggleRequired() {
    setError("");
    setBusy(true);
    try {
      await mutate("set_task_checklist_required", {
        p_task: task.id,
        p_required: !required,
      });
      notify(
        required
          ? "O checklist deixou de ser exigido para entregar."
          : "A tarefa só vai para Em validação ou Entregue com o checklist concluído.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function move(list: TaskChecklist, by: -1 | 1) {
    const ids = lists.map((l) => l.id);
    const at = ids.indexOf(list.id);
    const to = at + by;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    void act("reorder_task_checklists", { p_task: task.id, p_ids: ids }).catch(
      () => {},
    );
  }

  return (
    <div className="checklist-panel">
      <div className={`checklist-rule${required ? " on" : ""}`}>
        <Lock size={15} aria-hidden="true" />
        <div>
          <strong>
            {required ? "Exigido para entregar" : "Não exigido para entregar"}
          </strong>
          <small>
            {required
              ? open
                ? `Faltam ${open === 1 ? "1 item" : `${open} itens`} para a tarefa ir para Em validação ou Entregue.`
                : total
                  ? "Tudo marcado: a tarefa já pode ser entregue."
                  : "Sem itens ainda: a entrega fica livre até alguém criar um checklist."
              : "Itens em aberto não impedem a entrega."}
          </small>
        </div>
        {canManage && (
          <button
            type="button"
            role="switch"
            aria-checked={required}
            aria-label="Exigir o checklist concluído para entregar"
            title={
              required
                ? "Clique para deixar a entrega livre"
                : "Clique para só entregar com o checklist concluído"
            }
            className={`template-switch${required ? " on" : ""}`}
            disabled={busy}
            onClick={() => void toggleRequired()}
          >
            <span aria-hidden="true" />
            {required ? "Sim" : "Não"}
          </button>
        )}
      </div>
      {lists.length > 1 && total > 0 && (
        <div className="checklist-overall" aria-live="polite">
          <span>
            {total - open} de {total}{" "}
            {total === 1 ? "item concluído" : "itens concluídos"}
          </span>
          <Progress done={total - open} total={total} />
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {lists.map((l, i) => (
        <ChecklistCard
          key={l.id}
          list={l}
          user={user}
          canManage={canManage}
          isLeader={isLeader}
          first={i === 0}
          last={i === lists.length - 1}
          focusAdd={focusList === l.id}
          memberName={memberName}
          act={act}
          onLists={(next) =>
            onLists(lists.map((x) => (x.id === l.id ? next : x)))
          }
          onMove={(by) => move(l, by)}
          onSaveAsModel={() => setSaving(l)}
          onFocused={() => setFocusList("")}
          onError={setError}
          lists={lists}
          restore={onLists}
        />
      ))}
      {!lists.length && (
        <p className="muted centered checklist-empty">
          Quebre a entrega em passos: crie um checklist abaixo
          {models.length ? " ou use um modelo" : ""}.
        </p>
      )}
      <form
        className="checklist-new"
        onSubmit={(e) => {
          e.preventDefault();
          void createList();
        }}
      >
        <ListPlus size={16} aria-hidden="true" />
        <input
          className="ui-input"
          value={creating}
          maxLength={120}
          placeholder="Novo checklist (ex.: Revisão)"
          aria-label="Nome do novo checklist"
          disabled={busy}
          onChange={(e) => setCreating(e.target.value)}
        />
        <Button
          className="btn secondary"
          disabled={busy || !creating.trim()}
          aria-label="Criar checklist"
        >
          <Plus size={16} /> Criar
        </Button>
      </form>
      {models.length > 0 && (
        <label className="checklist-model-pick">
          Usar modelo
          <Select
            key={lists.length}
            value=""
            onValueChange={(v) => void applyModel(v)}
          >
            <SelectOption value="">Escolha um modelo…</SelectOption>
            {models.map((m) => (
              <SelectOption key={m.id} value={m.id}>
                {m.name}
              </SelectOption>
            ))}
          </Select>
        </label>
      )}
      <button
        type="button"
        className="checklist-log-toggle"
        aria-expanded={showLog}
        onClick={() => setShowLog((v) => !v)}
      >
        <History size={14} />
        {showLog ? "Ocultar registro" : "Ver registro do checklist"}
      </button>
      {showLog && (
        <ChecklistLog
          load={loadHistory}
          memberName={memberName}
          version={lists}
        />
      )}
      {saving && (
        <ChecklistTemplateEditor
          data={data}
          initial={{ name: saving.title, items: checklistAsItems(saving) }}
          onClose={() => setSaving(null)}
          onSave={async (t) => {
            await saveChecklistTemplate(mutate, company, t);
            notify(`Modelo “${t.name}” criado.`);
            setSaving(null);
          }}
        />
      )}
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span
      className={`checklist-progress${pct === 100 ? " full" : ""}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${pct}% concluído`}
    >
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

/** One checklist: its name, progress, items and subitems, and the composer. */
function ChecklistCard({
  list,
  lists,
  user,
  canManage,
  isLeader,
  first,
  last,
  focusAdd,
  memberName,
  act,
  onLists,
  restore,
  onMove,
  onSaveAsModel,
  onFocused,
  onError,
}: {
  list: TaskChecklist;
  lists: TaskChecklist[];
  user: string;
  canManage: boolean;
  isLeader: boolean;
  first: boolean;
  last: boolean;
  focusAdd: boolean;
  memberName: (id: string | null) => string;
  act: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<TaskChecklist[]>;
  onLists: (next: TaskChecklist) => void;
  restore: (lists: TaskChecklist[]) => void;
  onMove: (by: -1 | 1) => void;
  onSaveAsModel: () => void;
  onFocused: () => void;
  onError: (message: string) => void;
}) {
  const { done, total } = checklistProgress(list);
  const finished = !!list.completed_at;
  // Concluded ones start folded; the person opens them when needed.
  const [collapsed, setCollapsed] = useState(finished);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState("");
  const [subFor, setSubFor] = useState("");
  const [editing, setEditing] = useState("");
  const [drag, setDrag] = useState<{
    id: string;
    parent: string | null;
  } | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusAdd) return;
    setCollapsed(false);
    requestAnimationFrame(() => addInput.current?.focus());
    onFocused();
  }, [focusAdd, onFocused]);
  const mayChange = (author: string) => author === user || canManage;
  const tree = checklistTree(list.items);

  function toggle(item: ChecklistItem, next: boolean) {
    const before = lists;
    onLists(withItemDone(list, item.id, next, user));
    act("set_checklist_item_done", { p_item: item.id, p_done: next }).catch(
      () => restore(before),
    );
  }
  async function add(title: string, parent: string | null) {
    const text = title.trim();
    if (!text) return false;
    try {
      await act("add_checklist_item", {
        p_checklist: list.id,
        p_title: text,
        p_parent: parent,
      });
      return true;
    } catch {
      return false;
    }
  }
  function reorder(target: ChecklistItem) {
    if (!drag || drag.id === target.id || drag.parent !== target.parent_id)
      return;
    const level =
      drag.parent === null
        ? tree.map((t) => t.item)
        : (tree.find((t) => t.item.id === drag.parent)?.children ?? []);
    const ids = level.map((i) => i.id).filter((id) => id !== drag.id);
    ids.splice(ids.indexOf(target.id), 0, drag.id);
    const position = new Map(ids.map((id, n) => [id, n]));
    onLists({
      ...list,
      items: list.items.map((i) =>
        position.has(i.id) ? { ...i, position: position.get(i.id)! } : i,
      ),
    });
    act("reorder_checklist_items", {
      p_checklist: list.id,
      p_parent: drag.parent,
      p_ids: ids,
    }).catch(() => {});
    setDrag(null);
  }

  const row = (item: ChecklistItem, parent: ChecklistItem | null) => {
    const kids = parent
      ? []
      : (tree.find((t) => t.item.id === item.id)?.children ?? []);
    const editable = mayChange(item.created_by);
    return (
      <li
        key={item.id}
        className={`checklist-item${item.done ? " done" : ""}${drag?.id === item.id ? " dragging" : ""}`}
        onDragOver={(e) => {
          if (drag && drag.parent === item.parent_id && drag.id !== item.id)
            e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          reorder(item);
        }}
      >
        <div className="checklist-row">
          <span
            className="checklist-grip"
            draggable
            title="Arraste para reordenar"
            aria-hidden="true"
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = "move";
              setDrag({ id: item.id, parent: item.parent_id });
            }}
            onDragEnd={() => setDrag(null)}
          >
            <GripVertical size={14} />
          </span>
          <Checkbox
            checked={
              item.done
                ? true
                : kids.some((k) => k.done)
                  ? "indeterminate"
                  : false
            }
            aria-label={`${item.done ? "Desmarcar" : "Marcar"} ${item.title}`}
            onCheckedChange={() => toggle(item, !item.done)}
          />
          {editing === item.id ? (
            <InlineEdit
              value={item.title}
              maxLength={500}
              label="Editar item"
              onCancel={() => setEditing("")}
              onSave={async (title) => {
                await act("edit_checklist_item", {
                  p_item: item.id,
                  p_title: title,
                });
                setEditing("");
              }}
            />
          ) : (
            <span
              className="checklist-title"
              onDoubleClick={() => editable && setEditing(item.id)}
            >
              <span className="checklist-text">{item.title}</span>
              {item.done && item.done_by && item.done_at && (
                <small>
                  <span data-person={item.done_by}>
                    {memberName(item.done_by).split(" ")[0]}
                  </span>{" "}
                  · {when(item.done_at)}
                </small>
              )}
            </span>
          )}
          {editing !== item.id && (
            <span className="checklist-actions">
              {!parent && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Adicionar subitem em ${item.title}`}
                  title="Adicionar subitem"
                  onClick={() => setSubFor(item.id)}
                >
                  <CornerDownRight size={14} />
                </button>
              )}
              {editable && (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Editar ${item.title}`}
                    title="Editar"
                    onClick={() => setEditing(item.id)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Excluir ${item.title}`}
                    title={
                      kids.length
                        ? `Excluir (com ${kids.length === 1 ? "1 subitem" : `${kids.length} subitens`})`
                        : "Excluir"
                    }
                    onClick={() =>
                      void act("delete_checklist_item", {
                        p_item: item.id,
                      }).catch(() => {})
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </span>
          )}
        </div>
        {!parent && (kids.length > 0 || subFor === item.id) && (
          <ul className="checklist-subitems">
            {kids.map((k) => row(k, item))}
            {subFor === item.id && (
              <li className="checklist-add sub">
                <QuickAdd
                  placeholder="Novo subitem — Enter para adicionar"
                  autoFocus
                  onAdd={(title) => add(title, item.id)}
                  onClose={() => setSubFor("")}
                />
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  const menu = (
    label: string,
    icon: ReactNode,
    action: () => void,
    danger = false,
  ) => (
    <Popover.Close asChild>
      <button
        type="button"
        className={`drive-menu-item ${danger ? "danger" : ""}`}
        onClick={action}
      >
        {icon}
        {label}
      </button>
    </Popover.Close>
  );
  const listEditable = mayChange(list.created_by);

  return (
    <section
      className={`checklist-card${finished ? " finished" : ""}`}
      aria-label={`Checklist ${list.title}`}
    >
      <header className="checklist-head">
        <button
          type="button"
          className="icon-btn checklist-fold"
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? `Abrir ${list.title}` : `Recolher ${list.title}`
          }
          onClick={() => setCollapsed((v) => !v)}
        >
          <ChevronDown size={16} className={collapsed ? "" : "open"} />
        </button>
        {renaming ? (
          <InlineEdit
            value={list.title}
            maxLength={120}
            label="Nome do checklist"
            onCancel={() => setRenaming(false)}
            onSave={async (title) => {
              await act("rename_task_checklist", {
                p_checklist: list.id,
                p_title: title,
              });
              setRenaming(false);
            }}
          />
        ) : (
          <h4 onDoubleClick={() => listEditable && setRenaming(true)}>
            {list.title}
          </h4>
        )}
        <span className="checklist-count">
          {done}/{total}
        </span>
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Ações do checklist ${list.title}`}
              title="Mais ações"
            >
              <EllipsisVertical size={16} />
            </button>
          </Popover.Trigger>
          <Popover.Content
            className="drive-menu"
            align="end"
            sideOffset={4}
            collisionPadding={12}
          >
            {total > done &&
              menu(
                "Concluir checklist",
                <CheckCheck size={15} />,
                () =>
                  void act("complete_task_checklist", {
                    p_checklist: list.id,
                  }).catch(() => {}),
              )}
            {listEditable &&
              menu("Renomear", <Pencil size={14} />, () => setRenaming(true))}
            {!first &&
              menu("Mover para cima", <ArrowUp size={15} />, () => onMove(-1))}
            {!last &&
              menu("Mover para baixo", <ArrowDown size={15} />, () =>
                onMove(1),
              )}
            {isLeader &&
              total > 0 &&
              menu("Salvar como modelo", <Save size={15} />, onSaveAsModel)}
            {listEditable && (
              <>
                <hr />
                {menu(
                  "Excluir checklist",
                  <Trash2 size={15} />,
                  () => (total ? setConfirmDelete(true) : void remove()),
                  true,
                )}
              </>
            )}
          </Popover.Content>
        </Popover.Root>
      </header>
      <Progress done={done} total={total} />
      {finished && list.completed_at && (
        <small className="checklist-finished">
          <CheckCheck size={13} /> Concluído por{" "}
          <span data-person={list.completed_by ?? undefined}>
            {memberName(list.completed_by)}
          </span>{" "}
          em {when(list.completed_at)}
        </small>
      )}
      {confirmDelete && (
        <div className="checklist-confirm" role="alert">
          Excluir “{list.title}” e{" "}
          {total === 1 ? "o item" : `os ${total} itens`}? Fica no registro.
          <Button
            className="btn secondary"
            onClick={() => setConfirmDelete(false)}
          >
            Não
          </Button>
          <Button className="btn danger" onClick={() => void remove()}>
            Excluir
          </Button>
        </div>
      )}
      {!collapsed && (
        <>
          <ul className="checklist-items">
            {tree.map((t) => row(t.item, null))}
          </ul>
          <div className="checklist-add">
            <QuickAdd
              inputRef={addInput}
              placeholder="Adicionar item — Enter para o próximo"
              onAdd={(title) => add(title, null)}
            />
          </div>
        </>
      )}
    </section>
  );

  async function remove() {
    setConfirmDelete(false);
    try {
      await act("delete_task_checklist", { p_checklist: list.id });
    } catch (e) {
      onError((e as Error).message);
    }
  }
}

/**
 * The quick composer: Enter adds and keeps the field open for the next one;
 * Esc (or leaving it empty) closes a subitem's.
 */
function QuickAdd({
  placeholder,
  autoFocus,
  inputRef,
  onAdd,
  onClose,
}: {
  placeholder: string;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onAdd: (title: string) => Promise<boolean>;
  onClose?: () => void;
}) {
  const [value, setValue] = useState("");
  // The field empties right away for the next item; the items go out one
  // after the other, in the order typed (a failed one comes back).
  const queue = useRef(Promise.resolve());
  function submit() {
    const title = value.trim();
    if (!title) return;
    setValue("");
    queue.current = queue.current.then(async () => {
      if (!(await onAdd(title))) setValue((v) => v || title);
    });
  }
  function key(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && onClose) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }
  return (
    <span className="checklist-quick">
      <Plus size={15} aria-hidden="true" />
      <input
        className="ui-input"
        ref={inputRef}
        value={value}
        maxLength={500}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={key}
        onBlur={() => {
          if (!value.trim()) onClose?.();
        }}
      />
    </span>
  );
}

/** Renaming in place: Enter saves, Esc cancels, leaving the field saves. */
function InlineEdit({
  value,
  maxLength,
  label,
  onSave,
  onCancel,
}: {
  value: string;
  maxLength: number;
  label: string;
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  async function save() {
    if (done.current) return;
    done.current = true;
    if (!text.trim() || text.trim() === value) return onCancel();
    try {
      await onSave(text.trim());
    } catch {
      done.current = false;
    }
  }
  return (
    <input
      className="ui-input checklist-inline"
      value={text}
      maxLength={maxLength}
      aria-label={label}
      autoFocus
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => void save()}
    />
  );
}

/** The whole record, newest first (reloaded as the checklists change). */
function ChecklistLog({
  load,
  memberName,
  version,
}: {
  load: () => Promise<ChecklistLogEntry[]>;
  memberName: (id: string | null) => string;
  version: unknown;
}) {
  const [rows, setRows] = useState<ChecklistLogEntry[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    load()
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [load, version]);
  if (error)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!rows) return <p className="muted">Carregando o registro…</p>;
  if (!rows.length) return <p className="muted">Nada registrado ainda.</p>;
  return (
    <ol className="checklist-log">
      {rows.map((r) => (
        <li key={r.id}>
          <span>{checklistLogLabel(r)}</span>
          <small>
            <span data-person={r.actor_id}>{memberName(r.actor_id)}</span> ·{" "}
            {new Date(r.created_at).toLocaleString("pt-BR")}
          </small>
        </li>
      ))}
    </ol>
  );
}
