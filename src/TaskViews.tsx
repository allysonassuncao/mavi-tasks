import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Bookmark, ChevronDown, Plus, Star, Trash2 } from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input } from "./ui";
import type { TaskView } from "./api";
import {
  GROUP_OPTIONS,
  THEN_OPTIONS,
  sameViewConfig,
  type TaskViewConfig,
} from "./task-grouping";
import { statuses, type Snapshot, type Status } from "./types";
import { TASK_SCOPES } from "./domain";

const VIEW_NAMES: Record<string, string> = {
  list: "Lista",
  board: "Quadro",
  calendar: "Calendário",
  gantt: "Gantt",
};

/** What a config keeps, in words ("Agrupar por: Cliente", "Atrasadas"…). */
function configParts(c: TaskViewConfig, data: Snapshot) {
  return [
    `Agrupar por: ${GROUP_OPTIONS.find((o) => o.id === (c.group ?? "auto"))?.label}`,
    c.then && c.then !== "none"
      ? `Depois por: ${THEN_OPTIONS.find((o) => o.id === c.then)?.label}`
      : "",
    VIEW_NAMES[c.view ?? "list"] ?? "",
    c.scope ? TASK_SCOPES.find((s) => s.id === c.scope)?.label ?? "" : "",
    c.status ? statuses[c.status as Status]?.label ?? "" : "",
    c.product ? data.products.find((p) => p.id === c.product)?.name ?? "" : "",
    c.client ? data.clients.find((x) => x.id === c.client)?.name ?? "" : "",
    c.project ? data.projects.find((p) => p.id === c.project)?.name ?? "" : "",
    c.late ? "Atrasadas" : "",
    c.priority ? "Prioritárias" : "",
  ].filter(Boolean);
}

/**
 * The person's saved views of the task list: pick one to apply it, save
 * the current split and filters with a name, choose the one that opens by
 * default. Only the person sees their views.
 */
export function TaskViewsMenu({
  views,
  current,
  data,
  onApply,
  onSave,
  onDelete,
  onSetDefault,
}: {
  views: TaskView[];
  current: TaskViewConfig;
  data: Snapshot;
  onApply: (view: TaskView) => void;
  onSave: (name: string, isDefault: boolean) => Promise<unknown>;
  onDelete: (view: TaskView) => Promise<unknown>;
  onSetDefault: (view: TaskView, isDefault: boolean) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = views.find((v) => sameViewConfig(v.config, current));
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          setConfirming(null);
        }}
      >
        <Popover.Trigger asChild>
          <button type="button" className="views-trigger">
            <Bookmark size={15} />
            <span>{active ? active.name : "Visões"}</span>
            <ChevronDown size={14} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="views-menu" align="end" sideOffset={6} collisionPadding={12}>
            <p className="views-cap">Suas visões · só você vê</p>
            {!views.length && (
              <p className="views-empty">
                Monte a lista do seu jeito e salve para voltar a ela com um clique.
              </p>
            )}
            {views.map((v) => (
              <div className={`views-item ${v.id === active?.id ? "current" : ""}`} key={v.id}>
                {confirming === v.id ? (
                  <>
                    <span className="views-confirm">Excluir “{v.name}”?</span>
                    <Button
                      className="text-btn danger"
                      loading={busy}
                      onClick={() => act(() => onDelete(v)).then(() => setConfirming(null))}
                    >
                      Excluir
                    </Button>
                    <Button className="text-btn" onClick={() => setConfirming(null)}>
                      Cancelar
                    </Button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="views-pick"
                      onClick={() => {
                        onApply(v);
                        setOpen(false);
                      }}
                    >
                      <Bookmark size={14} />
                      <span>{v.name}</span>
                      {v.is_default && <small>abre por padrão</small>}
                    </button>
                    <button
                      type="button"
                      className={`icon-btn ${v.is_default ? "starred" : ""}`}
                      aria-label={
                        v.is_default
                          ? `Não abrir “${v.name}” por padrão`
                          : `Abrir “${v.name}” por padrão`
                      }
                      title={v.is_default ? "Não abrir por padrão" : "Abrir por padrão"}
                      disabled={busy}
                      onClick={() => act(() => onSetDefault(v, !v.is_default))}
                    >
                      <Star size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Excluir “${v.name}”`}
                      title="Excluir"
                      onClick={() => setConfirming(v.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            ))}
            <hr />
            <button
              type="button"
              className="views-pick"
              disabled={!!active}
              title={active ? `A lista já está como “${active.name}”` : undefined}
              onClick={() => {
                setOpen(false);
                setSaving(true);
              }}
            >
              <Plus size={14} />
              <span>Salvar visão atual…</span>
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {saving && (
        <SaveViewDialog
          parts={configParts(current, data)}
          first={!views.length}
          onClose={() => setSaving(false)}
          onSave={(name, isDefault) => onSave(name, isDefault).then(() => setSaving(false))}
        />
      )}
    </>
  );
}

function SaveViewDialog({
  parts,
  first,
  onClose,
  onSave,
}: {
  parts: string[];
  first: boolean;
  onClose: () => void;
  onSave: (name: string, isDefault: boolean) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [isDefault, setDefault] = useState(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Salvar visão" onClose={onClose} busy={busy}>
      <form
        className="entity-form views-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onSave(name.trim(), isDefault);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Não foi possível salvar.");
            setBusy(false);
          }
        }}
      >
        <p className="views-intro">
          Guarda o agrupamento, a visualização e os filtros de agora. Só você vê suas visões.
        </p>
        <div className="views-parts">
          {parts.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
        <label>
          Nome da visão
          <Input
            value={name}
            maxLength={60}
            required
            placeholder="Ex.: Pacotes da semana"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="views-default">
          <Checkbox checked={isDefault} onCheckedChange={(v) => setDefault(v === true)} />
          Abrir esta visão por padrão
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy} disabled={!name.trim()}>
            Salvar visão
          </Button>
        </div>
      </form>
    </Modal>
  );
}
