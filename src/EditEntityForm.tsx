import { useState, type FormEvent } from "react";
import { Save } from "lucide-react";
import { Modal } from "./components";
import { Input, Select, SelectOption, Button } from "./ui";
import type { Client, Contract, Product, Project, Snapshot } from "./types";
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
  const labels = {
    client: "cliente",
    product: "produto",
    project: "projeto",
    contract: "produto contratado",
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const args: Record<string, unknown> = {
      [`p_${edit.kind}`]: edit.entity.id,
      p_name: f.get("name"),
    };
    if (edit.kind === "client") args.p_email = f.get("email");
    if (edit.kind === "project") {
      args.p_due = f.get("due") || null;
      args.p_contract = f.get("contract");
    }
    if (edit.kind === "contract") {
      args.p_client = f.get("client");
      args.p_product = f.get("product");
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
        {edit.kind === "client" && (
          <label>
            E-mail
            <Input type="email" name="email" defaultValue={edit.entity.email} />
          </label>
        )}
        {edit.kind === "project" && (
          <>
            <label>
              Produto contratado
              <Select name="contract" defaultValue={edit.entity.contract_id}>
                {data.contracts.map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {data.clients.find((x) => x.id === c.client_id)?.name} ·{" "}
                    {c.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <small>
              Projetos agrupam entregas de um produto contratado. Projetos que
              já possuem tarefas mantêm esse vínculo.
            </small>
            <label>
              Prazo
              <Input
                type="date"
                name="due"
                defaultValue={edit.entity.due_date ?? ""}
              />
            </label>
          </>
        )}
        {edit.kind === "contract" && (
          <>
            <label>
              Cliente
              <Select name="client" defaultValue={edit.entity.client_id}>
                {data.clients.map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {c.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <label>
              Produto
              <Select name="product" defaultValue={edit.entity.product_id}>
                {data.products.map((p) => (
                  <SelectOption key={p.id} value={p.id}>
                    {p.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <small>
              Este vínculo representa o serviço ativo do cliente. Projetos e
              tarefas continuam ligados a ele.
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
