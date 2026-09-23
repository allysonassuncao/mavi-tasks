import { useState, type FormEvent } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input } from "./ui";
import type { Snapshot, Team } from "./types";

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const roleLabel = {
  admin: "Administrador",
  manager: "Gestor",
  member: "Colaborador",
};

/**
 * Creates or edits a team: its people and, among them, its supervisors —
 * who validate the team's tasks in projects set to "Supervisor da equipe".
 */
export function TeamForm({
  team,
  data,
  company,
  busy,
  mutate,
  onClose,
}: {
  team?: Team;
  data: Snapshot;
  company: string;
  busy: boolean;
  mutate: Mutate;
  onClose: () => void;
}) {
  const current = data.teamMembers.filter((tm) => tm.team_id === team?.id);
  const [name, setName] = useState(team?.name ?? "");
  const [members, setMembers] = useState<string[]>(
    current.map((tm) => tm.user_id),
  );
  const [supervisors, setSupervisors] = useState<string[]>(
    current.filter((tm) => tm.supervisor).map((tm) => tm.user_id),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const people = data.members.filter(
    (m) => m.active || members.includes(m.user_id),
  );
  function toggleMember(id: string, on: boolean) {
    setMembers((list) =>
      on ? [...new Set([...list, id])] : list.filter((u) => u !== id),
    );
    if (!on) setSupervisors((list) => list.filter((u) => u !== id));
  }
  function toggleSupervisor(id: string) {
    if (supervisors.includes(id)) {
      setSupervisors((list) => list.filter((u) => u !== id));
    } else {
      setSupervisors((list) => [...list, id]);
      setMembers((list) => [...new Set([...list, id])]);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      await mutate(
        team ? "update_team" : "create_team",
        team
          ? {
              p_team: team.id,
              p_name: name,
              p_users: members,
              p_supervisors: supervisors,
            }
          : {
              p_company: company,
              p_name: name,
              p_users: members,
              p_supervisors: supervisors,
            },
      );
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={team ? "Editar equipe" : "Nova equipe"}
      onClose={() => {
        if (!saving) onClose();
      }}
      busy={saving}
    >
      <form className="entity-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          <label>
            Nome
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={120}
              placeholder="Ex.: Criação & Conteúdo"
            />
          </label>
          <fieldset className="team-people">
            <legend>Pessoas da equipe</legend>
            <small>
              Marque quem faz parte da equipe e quem é supervisor — pode haver
              mais de um, de qualquer perfil. Supervisores veem e validam as
              tarefas da equipe nos projetos configurados com “Supervisor da
              equipe”.
            </small>
            {people.map((m) => {
              const isMember = members.includes(m.user_id);
              const isSupervisor = supervisors.includes(m.user_id);
              return (
                <div
                  className={`team-person-row ${isMember ? "member" : ""}`}
                  key={m.user_id}
                >
                  <label className="checkbox-label">
                    <Checkbox
                      checked={isMember}
                      onCheckedChange={(on) =>
                        toggleMember(m.user_id, on === true)
                      }
                    />
                    <span>
                      {m.name}
                      <small>{roleLabel[m.role]}</small>
                    </span>
                  </label>
                  <button
                    type="button"
                    className={`supervisor-toggle ${isSupervisor ? "on" : ""}`}
                    aria-pressed={isSupervisor}
                    aria-label={`${m.name} é supervisor da equipe`}
                    onClick={() => toggleSupervisor(m.user_id)}
                  >
                    <ShieldCheck size={14} />
                    Supervisor
                  </button>
                </div>
              );
            })}
            {!supervisors.length && (
              <small className="form-hint" role="status">
                Sem supervisor, só administradores validam as tarefas desta
                equipe nos projetos que usam “Supervisor da equipe”.
              </small>
            )}
          </fieldset>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            disabled={saving}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button className="btn primary" loading={saving || busy}>
            {team ? "Salvar alterações" : "Criar equipe"} <Check size={17} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
