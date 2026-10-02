import { useState } from "react";
import { ListTodo, Pencil, Plus, Trash2 } from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Select, SelectOption, Textarea } from "./ui";
import {
  checklistText,
  parseChecklistText,
  templateItemCount,
} from "./checklist";
import type {
  ChecklistTemplate,
  ChecklistTemplateItem,
  Snapshot,
} from "./types";
import "./task-checklist.css";

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Where a model is suggested, in words. */
function suggestedIn(
  data: Snapshot,
  t: Pick<
    ChecklistTemplate,
    "product_id" | "team_id" | "client_id" | "project_id"
  >,
) {
  const product = data.products.find((p) => p.id === t.product_id)?.name;
  const team = data.teams.find((x) => x.id === t.team_id)?.name;
  const client = data.clients.find((c) => c.id === t.client_id)?.name;
  const project = data.projects.find((p) => p.id === t.project_id)?.name;
  if (!product && !team && !client && !project) return "Só aplicado à mão";
  return `Sugerido em ${[
    client && `cliente ${client}`,
    project && `projeto ${project}`,
    product && `produto ${product}`,
    team && `equipe ${team}`,
  ]
    .filter(Boolean)
    .join(" · ")}`;
}

/**
 * Settings (leaders), under Templates de tarefa: the company's checklist
 * models (migration 20270220090000_task_checklists).
 */
export function ChecklistTemplatesSection({
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
  const [editing, setEditing] = useState<ChecklistTemplate | "new" | null>(
    null,
  );
  const [toggling, setToggling] = useState("");
  const [error, setError] = useState("");
  const models = [...(data.checklistTemplates ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR"),
  );
  async function toggle(t: ChecklistTemplate) {
    setToggling(t.id);
    setError("");
    try {
      await saveChecklistTemplate(mutate, company, { ...t, active: !t.active });
      notify(
        t.active
          ? `Modelo “${t.name}” desativado: não aparece mais nas tarefas.`
          : `Modelo “${t.name}” ativado.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setToggling("");
    }
  }
  return (
    <section className="panel task-templates" id="config-checklists">
      <div className="panel-heading">
        <div>
          <h2>Modelos de checklist</h2>
          <p>
            Checklists prontos para aplicar nas tarefas; com cliente, projeto,
            produto ou equipe, a Nova tarefa já vem com eles marcados
          </p>
        </div>
        <Button className="btn secondary" onClick={() => setEditing("new")}>
          <Plus size={17} /> Novo modelo
        </Button>
      </div>
      {models.length ? (
        models.map((t) => {
          const n = templateItemCount(t.items);
          return (
            <div className="template-row" key={t.id}>
              <ListTodo size={18} aria-hidden="true" />
              <div>
                <strong>{t.name}</strong>
                <small>
                  {suggestedIn(data, t)} · {n} {n === 1 ? "item" : "itens"}
                </small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={t.active}
                aria-label={`${t.active ? "Desativar" : "Ativar"} modelo ${t.name}`}
                title={
                  t.active
                    ? "Ativo: aparece para aplicar nas tarefas. Clique para desativar."
                    : "Inativo: não aparece nas tarefas. Clique para ativar."
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
                aria-label={`Editar modelo ${t.name}`}
                title="Editar modelo"
                onClick={() => setEditing(t)}
              >
                <Pencil size={15} />
              </Button>
            </div>
          );
        })
      ) : (
        <p className="template-empty">
          Nenhum modelo ainda. Crie um para os passos que se repetem — conferir
          o briefing, exportar nos formatos, subir no Drive — e aplique em
          qualquer tarefa com um clique.
        </p>
      )}
      {error && (
        <p className="form-error template-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <ChecklistTemplateEditor
          data={data}
          template={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (t) => {
            await saveChecklistTemplate(mutate, company, t);
            notify(t.id ? "Modelo atualizado." : "Modelo criado.");
            setEditing(null);
          }}
          onDelete={async (id) => {
            await mutate("delete_checklist_template", { p_template: id });
            notify(
              "Modelo excluído. As tarefas que já usam o checklist ficam com ele.",
            );
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

export type ChecklistTemplateDraft = Omit<
  ChecklistTemplate,
  "id" | "company_id"
> & { id?: string };

export const saveChecklistTemplate = (
  mutate: Mutate,
  company: string,
  t: ChecklistTemplateDraft,
) =>
  mutate("save_checklist_template", {
    p_company: company,
    p_id: t.id ?? null,
    p_name: t.name,
    p_items: t.items,
    p_product: t.product_id,
    p_team: t.team_id,
    p_active: t.active,
    p_client: t.client_id ?? null,
    p_project: t.project_id ?? null,
  });

/**
 * A model being created or edited: its name, where it is suggested and its
 * items, one per line ("-" at the start makes a subitem). Also opened from
 * a task's checklist ("Salvar como modelo"), with its items.
 */
export function ChecklistTemplateEditor({
  data,
  template,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  data: Snapshot;
  template?: ChecklistTemplate;
  /** A new model's starting point (a task's checklist). */
  initial?: { name: string; items: ChecklistTemplateItem[] };
  onClose: () => void;
  onSave: (t: ChecklistTemplateDraft) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(template?.name ?? initial?.name ?? "");
  const [text, setText] = useState(() =>
    checklistText(template?.items ?? initial?.items ?? []),
  );
  const [product, setProduct] = useState(template?.product_id ?? "");
  const [team, setTeam] = useState(template?.team_id ?? "");
  const [client, setClient] = useState(template?.client_id ?? "");
  const [project, setProject] = useState(template?.project_id ?? "");
  // A project is of one contracted product: those of the client (and of the
  // product, when chosen).
  const contractOf = (projectId: string) =>
    data.contracts.find(
      (c) =>
        c.id === data.projects.find((p) => p.id === projectId)?.contract_id,
    );
  const projects = client
    ? data.projects
        .filter((p) => {
          const c = data.contracts.find((x) => x.id === p.contract_id);
          return (
            c?.client_id === client &&
            (!product || c.product_id === product) &&
            (!p.archived || p.id === project)
          );
        })
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    : [];
  const projectFits = !project || projects.some((p) => p.id === project);
  const scoped = !!(product || team || client || project);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const items = parseChecklistText(text);
  const count = templateItemCount(items);
  async function save() {
    if (name.trim().length < 2) return setError("Dê um nome ao modelo.");
    if (!items.length) return setError("Escreva ao menos um item.");
    if (count > 300) return setError("Um modelo pode ter até 300 itens.");
    setBusy(true);
    setError("");
    try {
      await onSave({
        id: template?.id,
        name: name.trim(),
        items,
        product_id: product || null,
        team_id: team || null,
        client_id: client || null,
        project_id: projectFits ? project || null : null,
        active: template?.active ?? true,
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        template ? `Modelo “${template.name}”` : "Novo modelo de checklist"
      }
      onClose={onClose}
      busy={busy}
    >
      <div className="entity-form checklist-model-editor">
        <label>
          Nome do modelo
          <Input
            value={name}
            maxLength={80}
            placeholder="Ex.: Entrega de criativos"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <small>Vira o nome do checklist na tarefa.</small>
        </label>
        <label>
          Itens
          <Textarea
            value={text}
            rows={10}
            placeholder={
              "Conferir o briefing\n- Público\n- Oferta e CTA\nExportar nos formatos\nSubir no Drive do cliente"
            }
            onChange={(e) => setText(e.target.value)}
          />
          <small>
            Um item por linha. Comece a linha com “-” para ela virar subitem do
            item de cima.{" "}
            {count > 0 && `${count} ${count === 1 ? "item" : "itens"}.`}
          </small>
        </label>
        <fieldset className="checklist-model-scope">
          <legend>Já marcar na Nova tarefa de</legend>
          <div className="form-columns">
            <label>
              Cliente
              <Select
                value={client}
                onValueChange={(v) => {
                  setClient(v);
                  if (contractOf(project)?.client_id !== v) setProject("");
                }}
              >
                <SelectOption value="">Qualquer cliente</SelectOption>
                {data.clients
                  .filter((c) => !c.archived || c.id === client)
                  .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
                  .map((c) => (
                    <SelectOption key={c.id} value={c.id}>
                      {c.name}
                    </SelectOption>
                  ))}
              </Select>
            </label>
            <label>
              Projeto
              <Select
                key={client}
                value={projectFits ? project : ""}
                onValueChange={setProject}
                disabled={!client}
              >
                <SelectOption value="">
                  {!client
                    ? "Escolha o cliente antes"
                    : projects.length
                      ? "Qualquer projeto"
                      : "Cliente sem projetos"}
                </SelectOption>
                {projects.map((p) => (
                  <SelectOption key={p.id} value={p.id}>
                    {p.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
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
          <small>
            {scoped
              ? "Vem marcado quando a tarefa bate com tudo o que foi escolhido; quem cria pode desmarcar. Fora daí, o modelo é aplicado à mão."
              : "Sem cliente, projeto, produto nem equipe, o modelo só é aplicado à mão, no checklist da tarefa ou na Nova tarefa."}
          </small>
        </fieldset>
        {items.length > 0 && (
          <div className="checklist-model-preview" aria-label="Prévia">
            <span>Prévia</span>
            <ul>
              {items.slice(0, 40).map((i, n) => (
                <li key={n}>
                  {i.title}
                  {!!i.children?.length && (
                    <ul>
                      {i.children.map((c, m) => (
                        <li key={m}>{c.title}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          {template &&
            onDelete &&
            (confirmDelete ? (
              <span className="template-delete-confirm">
                Excluir? As tarefas que já usam o checklist ficam com ele.
                <Button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Não
                </Button>
                <Button
                  type="button"
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
                type="button"
                className="btn secondary template-delete"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={15} /> Excluir modelo
              </Button>
            ))}
          <Button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            className="btn primary"
            loading={busy}
            onClick={() => void save()}
          >
            {template ? "Salvar modelo" : "Criar modelo"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
