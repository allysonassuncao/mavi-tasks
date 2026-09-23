import { ChevronRight } from "lucide-react";
import { Select, SelectOption } from "./ui";
import type { Snapshot } from "./types";
import { contractParts, contractProductLabel } from "./domain";

/**
 * Picks a contracted product the way people think about it — first the
 * client, then which of that client's products — and, optionally, one of
 * that product's projects. Replaces flat "Cliente · Produto — nome" lists.
 */
export function ContractPicker({
  data,
  contract,
  onContractChange,
  project,
  onProjectChange,
  name,
  projectName,
  disabled,
  allowed,
}: {
  data: Snapshot;
  contract: string;
  onContractChange: (id: string) => void;
  /** Pass with onProjectChange to also pick a project (optional). */
  project?: string;
  onProjectChange?: (id: string) => void;
  /** Form field names, when the picker lives in an uncontrolled form. */
  name?: string;
  projectName?: string;
  disabled?: boolean;
  /** Limits the choice to products the viewer may use (e.g. create tasks in). */
  allowed?: (contractId: string) => boolean;
}) {
  const contracts = data.contracts.filter(
    (c) => (!c.archived && (!allowed || allowed(c.id))) || c.id === contract,
  );
  const current = contracts.find((c) => c.id === contract);
  const clientId = current?.client_id ?? "";
  const clients = data.clients.filter((c) =>
    contracts.some((k) => k.client_id === c.id),
  );
  const clientContracts = contracts.filter((c) => c.client_id === clientId);
  const projects = data.projects.filter(
    (p) => p.contract_id === contract && (!p.archived || p.id === project),
  );
  const withProject = !!onProjectChange;
  function pickContract(id: string) {
    onContractChange(id);
    onProjectChange?.("");
  }
  const hidden = (
    <>
      {name && <input type="hidden" name={name} value={contract} />}
      {projectName && (
        <input type="hidden" name={projectName} value={project ?? ""} />
      )}
    </>
  );
  const projectSelect = withProject && projects.length > 0 && (
    <label>
      Projeto
      <Select
        value={project ?? ""}
        onValueChange={onProjectChange}
        disabled={disabled}
      >
        <SelectOption value="">Sem projeto · tarefa avulsa</SelectOption>
        {projects.map((p) => (
          <SelectOption key={p.id} value={p.id}>
            {p.name}
          </SelectOption>
        ))}
      </Select>
    </label>
  );
  if (contracts.length === 1 && current) {
    const { client } = contractParts(data, current.id);
    return (
      <>
        {hidden}
        <p className="contract-path">
          <span>{client?.name}</span>
          <ChevronRight size={14} aria-hidden="true" />
          <span>{contractProductLabel(data, current.id)}</span>
        </p>
        {projectSelect}
      </>
    );
  }
  return (
    <>
      {hidden}
      <div className="form-columns">
        <label>
          Cliente
          <Select
            required
            value={clientId}
            disabled={disabled}
            onValueChange={(next) => {
              const first = contracts.find((c) => c.client_id === next);
              if (first) pickContract(first.id);
            }}
          >
            {clients.map((c) => (
              <SelectOption key={c.id} value={c.id}>
                {c.name}
              </SelectOption>
            ))}
          </Select>
        </label>
        <label>
          Produto contratado
          <Select
            required
            value={contract}
            disabled={disabled || clientContracts.length < 2}
            onValueChange={pickContract}
          >
            {clientContracts.map((c) => (
              <SelectOption key={c.id} value={c.id}>
                {contractProductLabel(data, c.id)}
              </SelectOption>
            ))}
          </Select>
        </label>
      </div>
      {projectSelect}
    </>
  );
}
