import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  ListChecks,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Select, SelectOption, Textarea } from "./ui";
import { CustomFieldsForm } from "./CustomFieldsForm";
import { fieldIdFrom, fieldTypes, hasOptions } from "./templateFields";
import type {
  CustomFieldType,
  Snapshot,
  TaskTemplate,
  TemplateField,
} from "./types";

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Where a template applies, in words ("Make Ads · equipe Design"). */
function scopeOf(
  data: Snapshot,
  t: Pick<TaskTemplate, "product_id" | "team_id">,
) {
  const product = data.products.find((p) => p.id === t.product_id)?.name;
  const team = data.teams.find((x) => x.id === t.team_id)?.name;
  return [
    product ? `Produto ${product}` : "Qualquer produto",
    team ? `equipe ${team}` : "qualquer equipe",
  ].join(" · ");
}

/** Settings panel (leaders): the company's task templates. */
export function TaskTemplatesPanel({
  data,
  company,
  mutate,
  notify,
}: {
  data: Snapshot;
  company: string;
  mutate: Mutate;
  notify: (message: string) => void;
}) {
  const [editing, setEditing] = useState<TaskTemplate | "new" | null>(null);
  const [toggling, setToggling] = useState("");
  const [error, setError] = useState("");
  const save = (t: Omit<TaskTemplate, "company_id" | "id"> & { id?: string }) =>
    mutate("save_task_template", {
      p_company: company,
      p_id: t.id ?? null,
      p_name: t.name,
      p_product: t.product_id,
      p_team: t.team_id,
      p_fields: t.fields,
      p_active: t.active,
    });
  // Turning a template off keeps it (and its fields) for later; tasks
  // created meanwhile simply don't ask for them.
  async function toggle(t: TaskTemplate) {
    setToggling(t.id);
    setError("");
    try {
      await save({ ...t, active: !t.active });
      notify(
        t.active
          ? `Template “${t.name}” desativado: não aparece mais em novas tarefas.`
          : `Template “${t.name}” ativado.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setToggling("");
    }
  }
  const templates = [...(data.taskTemplates ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR"),
  );
  return (
    <section className="panel task-templates" id="config-templates">
      <div className="panel-heading">
        <div>
          <h2>Templates de tarefa</h2>
          <p>
            Campos extras pedidos na criação, conforme o produto e a equipe do
            responsável
          </p>
        </div>
        <Button className="btn secondary" onClick={() => setEditing("new")}>
          <Plus size={17} /> Novo template
        </Button>
      </div>
      {templates.length ? (
        templates.map((t) => (
          <div className="template-row" key={t.id}>
            <ListChecks size={18} aria-hidden="true" />
            <div>
              <strong>{t.name}</strong>
              <small>
                {scopeOf(data, t)} · {t.fields.length}{" "}
                {t.fields.length === 1 ? "campo" : "campos"}
                {t.fields.some((f) => f.required) &&
                  ` (${t.fields.filter((f) => f.required).length} obrigatório${t.fields.filter((f) => f.required).length > 1 ? "s" : ""})`}
              </small>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={t.active}
              aria-label={`${t.active ? "Desativar" : "Ativar"} template ${t.name}`}
              title={
                t.active
                  ? "Ativo: aparece ao criar novas tarefas. Clique para desativar."
                  : "Inativo: não aparece em novas tarefas. Clique para ativar."
              }
              className={`template-switch${t.active ? " on" : ""}`}
              disabled={toggling === t.id}
              onClick={() => void toggle(t)}
            >
              <span aria-hidden="true" />
              {t.active ? "Ativo" : "Inativo"}
            </button>
            <Button
              className="icon-btn"
              aria-label={`Editar template ${t.name}`}
              title="Editar template"
              onClick={() => setEditing(t)}
            >
              <Pencil size={15} />
            </Button>
          </div>
        ))
      ) : (
        <p className="template-empty">
          Nenhum template ainda. Crie um para pedir informações específicas —
          link do briefing, formato, quantidade de peças — ao criar tarefas de
          um produto ou de uma equipe.
        </p>
      )}
      {error && (
        <p className="form-error template-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <TemplateBuilder
          data={data}
          template={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (t) => {
            await save(t);
            notify(t.id ? "Template atualizado." : "Template criado.");
            setEditing(null);
          }}
          onDelete={async (id) => {
            await mutate("delete_task_template", { p_template: id });
            notify(
              "Template excluído. As tarefas já criadas mantêm seus campos.",
            );
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

/** A field being edited: `key` identifies the row; `id` is kept once saved. */
type Draft = TemplateField & {
  key: string;
  saved: boolean;
  optionsText: string;
};
const blankField = (): Draft => ({
  key: crypto.randomUUID(),
  id: "",
  label: "",
  type: "text",
  required: false,
  help: "",
  options: [],
  optionsText: "",
  saved: false,
});

/** The builder: name, where it applies, and its fields (with a preview). */
function TemplateBuilder({
  data,
  template,
  onClose,
  onSave,
  onDelete,
}: {
  data: Snapshot;
  template?: TaskTemplate;
  onClose: () => void;
  onSave: (
    t: Omit<TaskTemplate, "id" | "company_id"> & { id?: string },
  ) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [product, setProduct] = useState(template?.product_id ?? "");
  const [team, setTeam] = useState(template?.team_id ?? "");
  const [active, setActive] = useState(template?.active ?? true);
  const [fields, setFields] = useState<Draft[]>(() =>
    template?.fields.length
      ? template.fields.map((f) => ({
          ...f,
          key: crypto.randomUUID(),
          saved: true,
          help: f.help ?? "",
          optionsText: (f.options ?? []).join("\n"),
        }))
      : [blankField()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = (key: string, patch: Partial<Draft>) =>
    setFields((list) =>
      list.map((f) => (f.key === key ? { ...f, ...patch } : f)),
    );
  const move = (index: number, by: -1 | 1) =>
    setFields((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item);
      return next;
    });

  /** The fields as saved: ids for new ones, options from their lines. */
  const finalFields = useMemo(() => {
    const taken = fields.filter((f) => f.saved).map((f) => f.id);
    return fields.map((f): TemplateField => {
      const id = f.saved ? f.id : fieldIdFrom(f.label, taken);
      if (!f.saved) taken.push(id);
      const options = f.optionsText
        .split("\n")
        .map((o) => o.trim())
        .filter(Boolean);
      return {
        id,
        label: f.label.trim(),
        type: f.type,
        required: f.required,
        ...(f.help?.trim() ? { help: f.help.trim() } : {}),
        ...(hasOptions(f.type) ? { options: [...new Set(options)] } : {}),
      };
    });
  }, [fields]);
  const [preview, setPreview] = useState<Record<string, unknown>>({});

  function problem() {
    if (name.trim().length < 2) return "Dê um nome ao template.";
    if (!product && !team) return "Escolha um produto, uma equipe ou os dois.";
    if (!finalFields.length) return "Adicione pelo menos um campo.";
    const unnamed = finalFields.findIndex((f) => !f.label);
    if (unnamed >= 0) return `Dê um nome ao campo ${unnamed + 1}.`;
    const noOptions = finalFields.find(
      (f) => hasOptions(f.type) && !f.options?.length,
    );
    if (noOptions)
      return `Liste as opções de "${noOptions.label}", uma por linha.`;
    return "";
  }
  async function save() {
    const p = problem();
    if (p) return setError(p);
    setBusy(true);
    setError("");
    try {
      await onSave({
        id: template?.id,
        name: name.trim(),
        product_id: product || null,
        team_id: team || null,
        active,
        fields: finalFields,
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        template ? `Template “${template.name}”` : "Novo template de tarefa"
      }
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="entity-form template-builder">
        <div className="template-meta">
          <label>
            Nome do template
            <Input
              value={name}
              maxLength={80}
              placeholder="Ex.: Criativos de Make Ads"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="form-columns">
            <label>
              Produto
              <Select value={product} onValueChange={setProduct}>
                <SelectOption value="">Qualquer produto</SelectOption>
                {data.products.map((p) => (
                  <SelectOption key={p.id} value={p.id}>
                    {p.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <label>
              Equipe do responsável
              <Select value={team} onValueChange={setTeam}>
                <SelectOption value="">Qualquer equipe</SelectOption>
                {data.teams.map((t) => (
                  <SelectOption key={t.id} value={t.id}>
                    {t.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
          </div>
          <small className="template-scope-hint">
            Vale para tarefas{" "}
            {product
              ? `do produto ${data.products.find((p) => p.id === product)?.name}`
              : "de qualquer produto"}{" "}
            cujo responsável seja{" "}
            {team
              ? `da equipe ${data.teams.find((t) => t.id === team)?.name}`
              : "de qualquer equipe"}
            . Se outros templates também valerem, os campos se somam.
          </small>
          <label className="checkbox-label">
            <Checkbox
              checked={active}
              onCheckedChange={(v) => setActive(v === true)}
            />
            Ativo — aparece ao criar novas tarefas
          </label>
        </div>

        <div className="template-columns">
          <section className="template-fields" aria-label="Campos">
            <h3>Campos</h3>
            {fields.map((f, i) => (
              <div className="template-field" key={f.key}>
                <div className="template-field-head">
                  <span className="template-field-n">{i + 1}</span>
                  <Input
                    aria-label={`Nome do campo ${i + 1}`}
                    placeholder="Nome do campo (ex.: Link do briefing)"
                    value={f.label}
                    maxLength={120}
                    onChange={(e) => update(f.key, { label: e.target.value })}
                  />
                  <Button
                    className="icon-btn"
                    aria-label="Subir campo"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={15} />
                  </Button>
                  <Button
                    className="icon-btn"
                    aria-label="Descer campo"
                    disabled={i === fields.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={15} />
                  </Button>
                  <Button
                    className="icon-btn"
                    aria-label={`Remover campo ${f.label || i + 1}`}
                    disabled={fields.length === 1}
                    onClick={() =>
                      setFields((list) => list.filter((x) => x.key !== f.key))
                    }
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
                <div className="form-columns">
                  <label>
                    Tipo
                    <Select
                      value={f.type}
                      onValueChange={(v) =>
                        update(f.key, { type: v as CustomFieldType })
                      }
                    >
                      {fieldTypes.map((t) => (
                        <SelectOption key={t.type} value={t.type}>
                          {t.label}
                        </SelectOption>
                      ))}
                    </Select>
                  </label>
                  <label className="checkbox-label template-required">
                    <Checkbox
                      checked={f.required}
                      onCheckedChange={(v) =>
                        update(f.key, { required: v === true })
                      }
                    />
                    Obrigatório
                  </label>
                </div>
                {hasOptions(f.type) && (
                  <label>
                    Opções (uma por linha)
                    <Textarea
                      rows={3}
                      value={f.optionsText}
                      placeholder={"Feed\nStories\nReels"}
                      onChange={(e) =>
                        update(f.key, { optionsText: e.target.value })
                      }
                    />
                  </label>
                )}
                <label>
                  Instrução (opcional)
                  <Input
                    value={f.help ?? ""}
                    maxLength={300}
                    placeholder="Aparece abaixo do campo"
                    onChange={(e) => update(f.key, { help: e.target.value })}
                  />
                </label>
              </div>
            ))}
            <Button
              className="btn secondary"
              disabled={fields.length >= 40}
              onClick={() => setFields((list) => [...list, blankField()])}
            >
              <Plus size={16} /> Adicionar campo
            </Button>
          </section>

          <section className="template-preview" aria-label="Pré-visualização">
            <h3>
              <Eye size={15} aria-hidden="true" /> Como aparece na nova tarefa
            </h3>
            <CustomFieldsForm
              fields={finalFields
                .filter((f) => f.label)
                .map((f) => ({
                  ...f,
                  template_id: "preview",
                  template_name: name.trim() || "Novo template",
                }))}
              values={preview}
              onChange={setPreview}
            />
          </section>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          {template &&
            (confirmDelete ? (
              <span className="template-delete-confirm">
                Excluir? As tarefas já criadas mantêm seus campos.
                <Button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Não
                </Button>
                <Button
                  className="btn danger"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    onDelete(template.id).catch((e) => {
                      setError((e as Error).message);
                      setBusy(false);
                    });
                  }}
                >
                  Excluir
                </Button>
              </span>
            ) : (
              <Button
                className="btn secondary template-delete"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={15} /> Excluir template
              </Button>
            ))}
          <Button className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            className="btn primary"
            loading={busy}
            onClick={() => void save()}
          >
            Salvar template
          </Button>
        </div>
      </div>
    </Modal>
  );
}
