import { useState, type FormEvent } from "react";
import { Save } from "lucide-react";
import { Modal } from "./components";
import { Input, Select, SelectOption, Button } from "./ui";
import type { Client, Contract, Product, Project, Snapshot } from "./types";
import { ContractPicker } from "./ContractPicker";
import { TeamPicker } from "./TeamPicker";
import { ReviewSettings } from "./ReviewSettings";
import { ColorField, PRODUCT_COLORS } from "./ColorMenu";
import { contractDetail, defaultContractName, projectReview } from "./domain";
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
  const [clientTeams, setClientTeams] = useState(() =>
    edit.kind === "client"
      ? data.clientTeams
          .filter((ct) => ct.client_id === edit.entity.id)
          .map((ct) => ct.team_id)
      : [],
  );
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
