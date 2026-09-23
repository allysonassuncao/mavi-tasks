import { Checkbox } from "./ui";
import type { ProjectApprover, Snapshot } from "./types";

/** Project setting: do tasks need validation, and who validates them. */
export function ReviewSettings({
  data,
  contractId,
  required,
  approver,
  onRequiredChange,
  onApproverChange,
}: {
  data: Snapshot;
  contractId: string;
  required: boolean;
  approver: ProjectApprover;
  onRequiredChange: (required: boolean) => void;
  onApproverChange: (approver: ProjectApprover) => void;
}) {
  const clientId = data.contracts.find((c) => c.id === contractId)?.client_id;
  const clientTeams = new Set(
    data.clientTeams
      .filter((ct) => ct.client_id === clientId)
      .map((ct) => ct.team_id),
  );
  const supervisors = data.members.filter(
    (m) =>
      m.active &&
      data.teamMembers.some(
        (tm) =>
          tm.user_id === m.user_id &&
          tm.supervisor &&
          clientTeams.has(tm.team_id),
      ),
  );
  const options: { id: ProjectApprover; title: string; body: string }[] = [
    {
      id: "creator",
      title: "Criador da tarefa",
      body: "Quem criou a tarefa aprova ou pede ajustes.",
    },
    {
      id: "supervisor",
      title: "Supervisor da equipe",
      body: "Um supervisor da equipe da tarefa aprova ou pede ajustes.",
    },
  ];
  return (
    <fieldset className="review-settings">
      <legend>Validação das tarefas</legend>
      <label className="checkbox-label review-toggle">
        <Checkbox
          checked={required}
          onCheckedChange={(on) => onRequiredChange(on === true)}
        />
        Exigir validação antes de concluir
      </label>
      <small>
        {required
          ? "Ao terminar, o responsável envia a tarefa para validação."
          : "Ao terminar, o responsável conclui a tarefa direto, sem aprovação."}
      </small>
      {required && (
        <>
          <div
            className="approver-options"
            role="radiogroup"
            aria-label="Quem valida as tarefas"
          >
            {options.map((o) => (
              <button
                type="button"
                role="radio"
                aria-checked={approver === o.id}
                key={o.id}
                className={approver === o.id ? "selected" : ""}
                onClick={() => onApproverChange(o.id)}
              >
                <strong>{o.title}</strong>
                <span>{o.body}</span>
              </button>
            ))}
          </div>
          {approver === "supervisor" &&
            (supervisors.length ? (
              <small>
                Supervisores das equipes deste cliente:{" "}
                {supervisors.map((m) => m.name).join(", ")}.
              </small>
            ) : (
              <small className="form-hint" role="status">
                Nenhuma equipe deste cliente tem supervisor definido. Defina em
                Equipe e configurações › Equipes; enquanto isso, só
                administradores poderão validar.
              </small>
            ))}
        </>
      )}
      <small>Administradores podem validar em qualquer caso.</small>
    </fieldset>
  );
}
