import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Select, SelectOption } from "./ui";
import { statuses, type Member, type Role, type Snapshot, type Status } from "./types";
import type { MemberOpenWork } from "./api";
import {
  ADMIN_PAGES,
  MEMBER_OPT_IN,
  MODULES,
  hiddenModules,
  optInFor,
  roleAllows,
} from "./modules";
import { loadMemberPhones, saveMemberPhones } from "./temperature";
import { PhoneListField, phoneRows, phonesChanged } from "./PhoneListField";

const roles: { id: Role; label: string }[] = [
  { id: "member", label: "Colaborador — Execução de tarefas e apontamentos" },
  { id: "manager", label: "Gestor — Gestão de equipes e aprovações" },
  { id: "admin", label: "Administrador — Acesso total e configurações" },
];

/**
 * Admins and managers edit a person's name, access profile, teams and status.
 * Mirrors update_member: managers cannot touch admins or grant admin, and
 * nobody changes their own profile or deactivates themselves. Admins also
 * pick the modules the person sees (set_member_pages); admins and managers
 * turn on the extras, such as timing several tasks at once
 * (set_member_multi_timer), marking tasks Alta/Urgente
 * (set_member_task_priority; admins and managers always can), linking the
 * Agente Conversacional's n8n flows to clients (set_member_agent_linker;
 * admins and managers always can) and, for admins
 * and managers (who open the Painel
 * da MAVI), the inbox notices of the Copiloto's and the MAVI's new learnings
 * (set_member_lesson_alerts).
 * Deactivating someone who is the assignee and/or creator of tasks not
 * delivered (or of repeats) asks who takes their place in each role
 * (update_member's p_handover); the status of each task stays as it is.
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
  openWork,
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
  /** The person's queue, checked before deactivating them. */
  openWork: (userId: string) => Promise<MemberOpenWork>;
  onClose: () => void;
}) {
  const self = member.user_id === currentUser;
  const [name, setName] = useState(member.name);
  const [role, setRole] = useState<Role>(member.role);
  const [active, setActive] = useState(member.active);
  const [multiTimer, setMultiTimer] = useState(!!member.multi_timer);
  const [taskPriority, setTaskPriority] = useState(!!member.task_priority);
  const [agentLinker, setAgentLinker] = useState(!!member.agent_linker);
  const [copilotAlerts, setCopilotAlerts] = useState(
    !!member.lesson_alerts_copilot,
  );
  const [maviAlerts, setMaviAlerts] = useState(!!member.lesson_alerts_mavi);
  const [teams, setTeams] = useState<string[]>(
    data.teamMembers
      .filter((tm) => tm.user_id === member.user_id)
      .map((tm) => tm.team_id),
  );
  // Modules off for the person, a collaborator's opt-in ones included
  // (src/modules.ts); the database splits the list by profile.
  const [hidden, setHidden] = useState<string[]>(() => hiddenModules(member));
  // A new profile: the opt-in modules follow what is saved for it.
  const shownRole = useRef(member.role);
  useEffect(() => {
    if (shownRole.current === role) return;
    shownRole.current = role;
    const optIn = MEMBER_OPT_IN as readonly string[];
    setHidden((list) => [
      ...list.filter((id) => !optIn.includes(id)),
      ...hiddenModules({ ...member, role }).filter((id) => optIn.includes(id)),
    ]);
  }, [role, member]);
  // Celulares com WhatsApp: nos grupos dos clientes, as mensagens deles são do time.
  const [phones, setPhones] = useState([""]);
  const [savedPhones, setSavedPhones] = useState<string[]>([]);
  const canEditPhone = callerIsAdmin || member.role !== "admin" || self;
  useEffect(() => {
    loadMemberPhones(company, member.user_id)
      .then((p) => {
        setSavedPhones(p);
        setPhones(phoneRows(p));
      })
      .catch(() => {});
  }, [company, member.user_id]);
  // Desativando: quem assume as tarefas não entregues e as repetições.
  const deactivating = member.active && !active;
  const [work, setWork] = useState<MemberOpenWork | null>(null);
  const [workError, setWorkError] = useState("");
  const [handover, setHandover] = useState("");
  const loadWork = useRef(openWork);
  loadWork.current = openWork;
  useEffect(() => {
    if (!deactivating || work) return;
    let live = true;
    setWorkError("");
    loadWork.current(member.user_id)
      .then((w) => live && setWork(w))
      .catch((err) => live && setWorkError((err as Error).message));
    return () => {
      live = false;
    };
  }, [deactivating, work, member.user_id]);
  const needsHandover =
    deactivating && !!work && work.tasks + work.recurrences > 0;
  const heirs = data.members
    .filter((m) => m.active && m.user_id !== member.user_id)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
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
    if (deactivating && !work) {
      setError(
        workError
          ? `Não foi possível conferir as tarefas de ${member.name}: ${workError}`
          : `Aguarde: conferindo as tarefas de ${member.name}.`,
      );
      return;
    }
    if (needsHandover && !handover) {
      setError(`Escolha quem assume as tarefas de ${member.name}.`);
      return;
    }
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
        p_handover: needsHandover ? handover : null,
      });
      if (multiTimer !== !!member.multi_timer)
        await mutate("set_member_multi_timer", {
          p_company: company,
          p_user: member.user_id,
          p_on: multiTimer,
        });
      const leader = role === "admin" || role === "manager";
      // Leaders always mark Alta/Urgente: the switch is for everyone else.
      if (!leader && taskPriority !== !!member.task_priority)
        await mutate("set_member_task_priority", {
          p_company: company,
          p_user: member.user_id,
          p_on: taskPriority,
        });
      // The same for linking the Agente Conversacional's flows to clients.
      if (!leader && agentLinker !== !!member.agent_linker)
        await mutate("set_member_agent_linker", {
          p_company: company,
          p_user: member.user_id,
          p_on: agentLinker,
        });
      // Only leaders open the Painel da MAVI: a collaborator can't keep them.
      const copilotOn = leader && copilotAlerts;
      const maviOn = leader && maviAlerts;
      if (
        copilotOn !== !!member.lesson_alerts_copilot ||
        maviOn !== !!member.lesson_alerts_mavi
      )
        await mutate("set_member_lesson_alerts", {
          p_company: company,
          p_user: member.user_id,
          p_copilot: copilotOn,
          p_mavi: maviOn,
        });
      if (canEditPhone && phonesChanged(phones, savedPhones))
        setSavedPhones(await saveMemberPhones(company, member.user_id, phones));
      const before = [...hiddenModules(member)].sort().join();
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
          <PhoneListField
            phones={phones}
            onChange={setPhones}
            disabled={!canEditPhone}
            hint="Nos grupos de WhatsApp dos clientes, as mensagens destes números contam como do time."
          />
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
                Os módulos do menu que {name.trim() || member.name} vê, e a MAVI,
                o assistente que fica em todas as telas. O perfil de acesso
                continua valendo: o que ele não permite fica de fora. Meu perfil
                e Equipe e configurações seguem só o perfil.
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
                        {optInFor(m.id, role) && (
                          <small className="member-module-note">
                            desligado por padrão · ligado, tudo do módulo, só nos
                            clientes das equipes da pessoa
                          </small>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
          <fieldset className="member-teams member-extras">
            <legend>Recursos extras</legend>
            <label className="checkbox-label">
              <Checkbox
                checked={multiTimer}
                onCheckedChange={(on) => setMultiTimer(on === true)}
              />
              <span>
                Várias tarefas ao mesmo tempo
                <small className="member-module-note">
                  {multiTimer
                    ? "iniciar uma tarefa não pausa as outras; cada uma registra o tempo cheio e, nas horas da pessoa, o tempo junto conta uma vez"
                    : "desligado: iniciar uma tarefa pausa a que estava rodando"}
                </small>
              </span>
            </label>
            {!multiTimer && member.multi_timer && (
              <small className="form-hint" role="status">
                Ao salvar, só a tarefa iniciada por último continua rodando.
              </small>
            )}
            <label className="checkbox-label">
              <Checkbox
                checked={role === "admin" || role === "manager" || taskPriority}
                disabled={role === "admin" || role === "manager"}
                onCheckedChange={(on) => setTaskPriority(on === true)}
              />
              <span>
                Marcar prioridade
                <small className="member-module-note">
                  {role === "admin" || role === "manager"
                    ? "administradores e gestores sempre dão e tiram a prioridade Alta ou Urgente"
                    : taskPriority
                      ? "dá e tira a prioridade Alta ou Urgente nas tarefas que vê; elas ficam em destaque e no topo da lista"
                      : "desligado: marca só Baixa ou Normal (nas tarefas que edita)"}
                </small>
              </span>
            </label>
            <label className="checkbox-label">
              <Checkbox
                checked={role === "admin" || role === "manager" || agentLinker}
                disabled={role === "admin" || role === "manager"}
                onCheckedChange={(on) => setAgentLinker(on === true)}
              />
              <span>
                Agente Conversacional: ligar fluxos aos clientes
                <small className="member-module-note">
                  {role === "admin" || role === "manager"
                    ? "administradores e gestores sempre usam Trocar cliente e a aba Sem cliente"
                    : agentLinker
                      ? "usa Trocar cliente e vê a aba Sem cliente (liga, desliga e ignora fluxos do n8n), só nos clientes das equipes da pessoa"
                      : "desligado: só lê e edita os prompts dos clientes que atende"}
                </small>
              </span>
            </label>
            {role === "admin" || role === "manager" ? (
              <>
                <label className="checkbox-label">
                  <Checkbox
                    checked={copilotAlerts}
                    onCheckedChange={(on) => setCopilotAlerts(on === true)}
                  />
                  <span>
                    Avisos de aprendizados do Copiloto
                    <small className="member-module-note">
                      {copilotAlerts
                        ? "na caixa de entrada, quando a MAVI aprender algo novo em Painel da MAVI › Copiloto (um aviso por lote)"
                        : "desligado: os aprendizados novos ficam só no Painel da MAVI"}
                    </small>
                  </span>
                </label>
                <label className="checkbox-label">
                  <Checkbox
                    checked={maviAlerts}
                    onCheckedChange={(on) => setMaviAlerts(on === true)}
                  />
                  <span>
                    Avisos de aprendizados da MAVI
                    <small className="member-module-note">
                      {maviAlerts
                        ? "na caixa de entrada, quando a MAVI aprender algo novo em Painel da MAVI › Aprendizado da MAVI (um aviso por lote)"
                        : "desligado: os aprendizados novos ficam só no Painel da MAVI"}
                    </small>
                  </span>
                </label>
              </>
            ) : (
              (member.lesson_alerts_copilot || member.lesson_alerts_mavi) && (
                <small className="form-hint" role="status">
                  Ao salvar, os avisos de aprendizados da MAVI são desligados:
                  só administradores e gestores abrem o Painel da MAVI.
                </small>
              )
            )}
          </fieldset>
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
          {deactivating &&
            (work ? (
              needsHandover && (
                <div className="member-handover">
                  <p>
                    {member.name} tem {openWorkText(work)}. Escolha quem
                    assume: fica no lugar de {member.name} como responsável e
                    como criador, e o status de cada tarefa continua o mesmo.
                  </p>
                  <label>
                    Novo responsável
                    <Select
                      value={handover}
                      onValueChange={setHandover}
                      required
                    >
                      <SelectOption value="">Escolha o usuário</SelectOption>
                      {heirs.map((m) => (
                        <SelectOption key={m.user_id} value={m.user_id}>
                          {m.name}
                        </SelectOption>
                      ))}
                    </Select>
                  </label>
                </div>
              )
            ) : (
              <small className="form-hint" role="status">
                {workError
                  ? `Não foi possível conferir as tarefas de ${member.name}: ${workError}`
                  : `Conferindo as tarefas de ${member.name}…`}
              </small>
            ))}
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

/**
 * "3 tarefas não entregues (2 como responsável · 2 como criador; 2 Em
 * andamento · 1 Em validação) e 1 repetição".
 */
function openWorkText(work: MemberOpenWork) {
  const parts: string[] = [];
  if (work.tasks > 0) {
    const detail = (Object.keys(statuses) as Status[])
      .filter((s) => work.by_status[s])
      .map((s) => `${work.by_status[s]} ${statuses[s].label}`)
      .join(" · ");
    const roles = [
      work.as_assignee && `${work.as_assignee} como responsável`,
      work.as_creator && `${work.as_creator} como criador`,
    ]
      .filter(Boolean)
      .join(" · ");
    parts.push(
      `${work.tasks} ${work.tasks === 1 ? "tarefa não entregue" : "tarefas não entregues"} (${roles}; ${detail})`,
    );
  }
  if (work.recurrences > 0)
    parts.push(
      `${work.recurrences} ${work.recurrences === 1 ? "repetição" : "repetições"}`,
    );
  return parts.join(" e ");
}
