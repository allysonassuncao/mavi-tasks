import { useState, type FormEvent } from "react";
import { Save, Trash2 } from "lucide-react";
import { Modal } from "./components";
import { Input, Select, SelectOption, Button, Checkbox } from "./ui";
import type { Client, Contract, Product, Project, Snapshot } from "./types";
import { ContractPicker } from "./ContractPicker";
import { TeamPicker } from "./TeamPicker";
import { ReviewSettings } from "./ReviewSettings";
import { ColorField, PRODUCT_COLORS } from "./ColorMenu";
import {
  clientProductTeams,
  contractDetail,
  defaultContractName,
  productTeamIds,
  projectReview,
} from "./domain";
export type EntityEdit =
  | { kind: "client"; entity: Client }
  | { kind: "product"; entity: Product }
  | { kind: "project"; entity: Project }
  | { kind: "contract"; entity: Contract };
export function EditEntityForm({
  edit,
  data,
  busy,
  mutate,
  onClose,
}: {
  edit: EntityEdit;
  data: Snapshot;
  busy: boolean;
  mutate: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [contract, setContract] = useState(
    edit.kind === "project" ? edit.entity.contract_id : "",
  );
  const [review, setReview] = useState(() =>
    projectReview(edit.kind === "project" ? edit.entity : null),
  );
  const [linkClient, setLinkClient] = useState(
    edit.kind === "contract" ? edit.entity.client_id : "",
  );
  const [linkProduct, setLinkProduct] = useState(
    edit.kind === "contract" ? edit.entity.product_id : "",
  );
  const [color, setColor] = useState(
    edit.kind === "product" ? edit.entity.color : "",
  );
  const [projectField, setProjectField] = useState(
    edit.kind === "product" ? edit.entity.task_project_field !== false : true,
  );
  // Teams the client's products bring are locked; the picker edits extras.
  const fixedTeams =
    edit.kind === "client" ? clientProductTeams(data, edit.entity.id) : [];
  const [clientTeams, setClientTeams] = useState(() =>
    edit.kind === "client"
      ? data.clientTeams
          .filter(
            (ct) =>
              ct.client_id === edit.entity.id &&
              !fixedTeams.some((f) => f.team === ct.team_id),
          )
          .map((ct) => ct.team_id)
      : [],
  );
  const initialProductTeams =
    edit.kind === "product" ? productTeamIds(data, edit.entity.id) : [];
  const [productTeams, setProductTeams] = useState(initialProductTeams);
  // Before a product has teams: who already serves its clients, as a hint.
  const servingNow = (() => {
    if (edit.kind !== "product" || initialProductTeams.length) return [];
    const clients = new Set(
      data.contracts
        .filter((k) => k.product_id === edit.entity.id && !k.archived)
        .map((k) => k.client_id),
    );
    return data.teams
      .map((t) => ({
        team: t,
        count: data.clientTeams.filter(
          (ct) => ct.team_id === t.id && clients.has(ct.client_id),
        ).length,
        of: clients.size,
      }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
  })();
  const nameOf = (list: { id: string; name: string }[], id: string) =>
    list.find((x) => x.id === id)?.name ?? "";
  const labels = {
    client: "cliente",
    product: "produto",
    project: "projeto",
    contract: "produto do cliente",
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const args: Record<string, unknown> = {
      [`p_${edit.kind}`]: edit.entity.id,
      p_name: f.get("name"),
    };
    if (edit.kind === "client") {
      args.p_email = f.get("email");
      args.p_teams = clientTeams;
    }
    // Only when changed: renaming keeps working on databases still without
    // the color parameter (migration 20260929140000).
    if (edit.kind === "product" && color !== edit.entity.color)
      args.p_color = color;
    // Also only when changed (migration 20270517090000).
    if (
      edit.kind === "product" &&
      [...productTeams].sort().join() !== [...initialProductTeams].sort().join()
    )
      args.p_teams = productTeams;
    // Also only when changed (migration 20261008090000).
    if (
      edit.kind === "product" &&
      projectField !== (edit.entity.task_project_field !== false)
    )
      args.p_task_project_field = projectField;
    if (edit.kind === "project") {
      args.p_due = f.get("due") || null;
      args.p_contract = f.get("contract");
      args.p_requires_review = review.required;
      args.p_approver = review.approver;
    }
    if (edit.kind === "contract") {
      args.p_client = linkClient;
      args.p_product = linkProduct;
      args.p_name =
        String(f.get("name") ?? "").trim() ||
        defaultContractName(
          nameOf(data.products, linkProduct),
          nameOf(data.clients, linkClient),
        );
    }
    try {
      await mutate(`update_${edit.kind}`, args);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // Deleted when added by mistake; archived when it already has history
  // (see remove_contract, migration 20261206090000).
  async function removeContract() {
    try {
      await mutate("remove_contract", { p_contract: edit.entity.id });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title={`Editar ${labels[edit.kind]}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="entity-form" onSubmit={submit}>
        {edit.kind !== "contract" && (
          <label>
            Nome
            <Input
              name="name"
              defaultValue={edit.entity.name}
              required
              minLength={2}
              maxLength={120}
            />
          </label>
        )}
        {edit.kind === "client" && (
          <>
            <label>
              E-mail
              <Input
                type="email"
                name="email"
                defaultValue={edit.entity.email}
              />
            </label>
            <TeamPicker
              teams={data.teams}
              value={clientTeams}
              onChange={setClientTeams}
              fixed={fixedTeams}
              hint={
                fixedTeams.length
                  ? "As equipes travadas vêm dos produtos do cliente (mude em Produtos › Editar). Marque aqui só exceções. Os colaboradores de todas elas veem todos os produtos, projetos e tarefas deste cliente."
                  : clientTeams.length
                    ? "Os produtos deste cliente ainda não têm equipe responsável; estas atendem como exceção. Os colaboradores delas veem todos os produtos, projetos e tarefas deste cliente."
                    : "As equipes vêm dos produtos do cliente (defina em Produtos › Editar). Sem equipe, só administradores e gestores veem este cliente."
              }
            />
          </>
        )}
        {edit.kind === "product" && (
          <>
            <ColorField
              legend="Cor do produto"
              swatches={PRODUCT_COLORS}
              value={color}
              onChange={setColor}
            />
            <small className="color-field-preview">
              <span className="product-dot" style={{ background: color }} />É a
              cor que identifica o produto nas listas, no Drive e nos clientes.
            </small>
            <TeamPicker
              teams={data.teams}
              value={productTeams}
              onChange={setProductTeams}
              hint={
                productTeams.length
                  ? "Essas equipes atendem todos os clientes com este produto e veem todos os produtos, projetos e tarefas deles. Mudar aqui vale para todos esses clientes."
                  : "Sem equipe, os clientes com este produto ficam só com as equipes extras ou dos outros produtos deles."
              }
            />
            {servingNow.length > 0 && (
              <small className="form-hint" role="status">
                Hoje atendem os clientes deste produto:{" "}
                {servingNow
                  .map((x) => `${x.team.name} (${x.count} de ${x.of})`)
                  .join(", ")}
                .
              </small>
            )}
            <label className="checkbox-label">
              <Checkbox
                checked={projectField}
                onCheckedChange={(v) => setProjectField(v === true)}
              />
              Exibir o campo Projeto ao criar tarefas
            </label>
            <small>
              {projectField
                ? "Ao criar uma tarefa deste produto, o campo Projeto aparece quando o cliente tem projetos nele."
                : "Ao criar uma tarefa deste produto, o campo Projeto não aparece: as tarefas ficam avulsas."}
            </small>
          </>
        )}
        {edit.kind === "project" && (
          <>
            <ContractPicker
              data={data}
              contract={contract}
              onContractChange={setContract}
              name="contract"
            />
            <small>
              Mudar o cliente ou produto de um projeto que já tem tarefas pode
              ser recusado, para manter o histórico consistente.
            </small>
            <label>
              Prazo
              <Input
                type="date"
                name="due"
                defaultValue={edit.entity.due_date ?? ""}
              />
            </label>
            <ReviewSettings
              data={data}
              contractId={contract}
              required={review.required}
              approver={review.approver}
              onRequiredChange={(required) =>
                setReview((r) => ({ ...r, required }))
              }
              onApproverChange={(approver) =>
                setReview((r) => ({ ...r, approver }))
              }
            />
          </>
        )}
        {edit.kind === "contract" && (
          <>
            <div className="form-columns">
              <label>
                Cliente
                <Select value={linkClient} onValueChange={setLinkClient}>
                  {data.clients.map((c) => (
                    <SelectOption key={c.id} value={c.id}>
                      {c.name}
                    </SelectOption>
                  ))}
                </Select>
              </label>
              <label>
                Produto
                <Select value={linkProduct} onValueChange={setLinkProduct}>
                  {data.products.map((p) => (
                    <SelectOption key={p.id} value={p.id}>
                      {p.name}
                    </SelectOption>
                  ))}
                </Select>
              </label>
            </div>
            <label>
              Identificação (opcional)
              <Input
                name="name"
                maxLength={120}
                placeholder="Ex.: Unidade Centro, Contrato 2026"
                defaultValue={contractDetail(
                  edit.entity.name,
                  nameOf(data.products, edit.entity.product_id),
                  nameOf(data.clients, edit.entity.client_id),
                )}
              />
            </label>
            <small>
              Projetos e tarefas deste produto continuam ligados a ele.
            </small>
          </>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="form-footer">
          {edit.kind === "contract" &&
            (confirmRemove ? (
              <span className="template-delete-confirm">
                Remover do cliente? Se já tiver projetos, tarefas ou arquivos,
                o produto é arquivado e esse histórico fica guardado.
                <Button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => setConfirmRemove(false)}
                >
                  Não
                </Button>
                <Button
                  type="button"
                  className="btn danger"
                  loading={busy}
                  onClick={() => void removeContract()}
                >
                  Remover
                </Button>
              </span>
            ) : (
              <Button
                type="button"
                className="btn secondary template-delete"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 size={15} /> Remover do cliente
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
          <Button className="btn primary" loading={busy}>
            <Save size={17} /> Salvar alterações
          </Button>
        </div>
      </form>
    </Modal>
  );
}
