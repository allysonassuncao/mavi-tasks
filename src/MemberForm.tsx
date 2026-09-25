import { useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Select, SelectOption } from "./ui";
import type { Member, Role, Snapshot } from "./types";
import { ADMIN_PAGES, MODULES, roleAllows } from "./modules";

const roles: { id: Role; label: string }[] = [
  { id: "member", label: "Colaborador — Execução de tarefas e apontamentos" },
  { id: "manager", label: "Gestor — Gestão de equipes e aprovações" },
  { id: "admin", label: "Administrador — Acesso total e configurações" },
];

/**
 * Admins and managers edit a person's name, access profile, teams and status.
 * Mirrors update_member: managers cannot touch admins or grant admin, and
 * nobody changes their own profile or deactivates themselves. Admins also
 * pick the modules the person sees (set_member_pages).
 */
export function MemberForm({
  member,
  data,
  company,
  currentUser,
  callerIsAdmin,
  busy,
  mutate,
  syncAccess,
  onClose,
}: {
  member: Member;
  data: Snapshot;
  company: string;
  currentUser: string;
  callerIsAdmin: boolean;
  busy: boolean;
  mutate: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Blocks or restores the person's sign-in to match their new status. */
  syncAccess?: (userId: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const self = member.user_id === currentUser;
  const [name, setName] = useState(member.name);
  const [role, setRole] = useState<Role>(member.role);
  const [active, setActive] = useState(member.active);
  const [teams, setTeams] = useState<string[]>(
    data.teamMembers
      .filter((tm) => tm.user_id === member.user_id)
      .map((tm) => tm.team_id),
  );
  // Modules an administrator hid from the person (src/modules.ts).
  const [hidden, setHidden] = useState<string[]>(member.hidden_pages ?? []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Survives a failed sync, when `member` already reflects the saved status.
  const needsSync = useRef(false);
  const supervises = data.teamMembers.some(
    (tm) => tm.user_id === member.user_id && tm.supervisor,
  );
  const roleOptions = roles.filter((r) => callerIsAdmin || r.id !== "admin");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError("");
    setSaving(true);
    if (active !== member.active) needsSync.current = true;
    try {
      await mutate("update_member", {
        p_company: company,
        p_user: member.user_id,
        p_name: name.trim(),
        p_role: role,
        p_active: active,
        p_teams: teams,
      });
      const before = [...(member.hidden_pages ?? [])].sort().join();
      if (callerIsAdmin && [...hidden].sort().join() !== before)
        await mutate("set_member_pages", {
          p_company: company,
          p_user: member.user_id,
          p_hidden: hidden,
        });
      if (needsSync.current && syncAccess) {
        try {
          await syncAccess(member.user_id);
          needsSync.current = false;
        } catch (err) {
          setError(
            `O status foi salvo, mas o login não pôde ser ${
              active ? "liberado" : "bloqueado"
            }: ${(err as Error).message} Salve novamente para tentar outra vez.`,
          );
          return;
        }
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Editar usuário · ${member.name}`}
      onClose={() => {
        if (!saving) onClose();
      }}
      busy={saving}
    >
      <form className="entity-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          <label>
            Nome completo
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={120}
            />
          </label>
          <label>
            E-mail
            <Input value={member.email || "Não informado"} readOnly disabled />
          </label>
          <label>
            Perfil de acesso
            <Select
              value={role}
              onValueChange={(v) => setRole(v as Role)}
              disabled={self}
            >
              {roleOptions.map((r) => (
                <SelectOption key={r.id} value={r.id}>
                  {r.label}
                </SelectOption>
              ))}
            </Select>
          </label>
          {role === "member" && supervises && (
            <small className="form-hint" role="status">
              Como Colaborador, {member.name} deixa de ser supervisor das
              equipes em que está.
            </small>
          )}
          {data.teams.length > 0 && (
            <fieldset className="member-teams">
              <legend>Equipes</legend>
              <div className="team-picker-list">
                {data.teams.map((t) => (
                  <label className="checkbox-label" key={t.id}>
                    <Checkbox
                      checked={teams.includes(t.id)}
                      onCheckedChange={(on) =>
                        setTeams((list) =>
                          on === true
                            ? [...new Set([...list, t.id])]
                            : list.filter((id) => id !== t.id),
                        )
                      }
                    />
                    {t.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {callerIsAdmin && (
            <fieldset className="member-teams member-modules">
              <legend>Módulos visíveis</legend>
              <small>
                Os módulos do menu que {name.trim() || member.name} vê. O perfil
                de acesso continua valendo: o que ele não permite fica de fora.
                Meu perfil e Equipe e configurações seguem só o perfil.
              </small>
              <div className="team-picker-list">
                {MODULES.map((m) => {
                  const byRole = roleAllows(m.id, role);
                  return (
                    <label
                      className="checkbox-label"
                      key={m.id}
                      title={
                        byRole
                          ? undefined
                          : ADMIN_PAGES.includes(m.id)
                            ? "Só administradores veem este módulo"
                            : "Só gestores e administradores veem este módulo"
                      }
                    >
                      <Checkbox
                        checked={byRole && !hidden.includes(m.id)}
                        disabled={!byRole}
                        onCheckedChange={(on) =>
                          setHidden((list) =>
                            on === true
                              ? list.filter((id) => id !== m.id)
                              : [...new Set([...list, m.id])],
                          )
                        }
                      />
                      <span>
                        {m.label}
                        {!byRole && (
                          <small className="member-module-note">
                            {ADMIN_PAGES.includes(m.id)
                              ? "só administradores"
                              : "gestores e administradores"}
                          </small>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
          <label className="checkbox-label member-active">
            <Checkbox
              checked={active}
              disabled={self}
              onCheckedChange={(on) => setActive(on === true)}
            />
            Usuário ativo
          </label>
          <small>
            {self
              ? "Você não pode alterar o próprio perfil de acesso nem se desativar."
              : active
                ? "Usuários ativos acessam o espaço conforme o perfil e as equipes."
                : "Usuários inativos perdem o acesso ao espaço; o histórico é mantido."}
          </small>
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
            Salvar alterações <Check size={17} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
