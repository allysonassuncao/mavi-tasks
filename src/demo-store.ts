import { demoSnapshot, demoUser } from "./demo";
import { projectReview, taskActions } from "./domain";
import { mentionedIds, richTextPlain, transitionComment } from "./rich-text";
import {
  type Snapshot,
  type Status,
  type Task,
  type Comment,
  type Attachment,
  type TaskEvent,
  type AppNotification,
  statuses,
  workingStatuses,
} from "./types";
export class DemoStore {
  data: Snapshot = demoSnapshot();
  comments: Comment[] = [];
  attachments: Attachment[] = [];
  events: TaskEvent[] = [];
  /** Everyone's notifications (the demo person sees only theirs). */
  notifications: (AppNotification & { user_id: string })[] = [];
  constructor() {
    // One example, so the demo inbox isn't empty.
    const task = this.data.tasks.find((t) => t.assignee_id === demoUser);
    const actor = this.data.members.find((m) => m.user_id !== demoUser);
    if (task && actor)
      this.notifications.push({
        id: crypto.randomUUID(),
        user_id: demoUser,
        kind: "mention",
        task_id: task.id,
        task_title: task.title,
        actor_id: actor.user_id,
        actor_name: actor.name,
        excerpt: `@${this.data.members.find((m) => m.user_id === demoUser)?.name} pode revisar antes de enviar?`,
        read_at: null,
        created_at: new Date(Date.now() - 3600_000).toISOString(),
      });
  }
  inbox(user: string): AppNotification[] {
    return this.notifications
      .filter((n) => n.user_id === user)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  readNotifications(user: string, ids?: string[]) {
    const at = new Date().toISOString();
    for (const n of this.notifications)
      if (n.user_id === user && !n.read_at && (!ids || ids.includes(n.id)))
        n.read_at = at;
  }
  /** Mirrors mavi_private.comment_mentions: participants and notifications. */
  private mentionsIn(comment: Comment) {
    const task = this.data.tasks.find((t) => t.id === comment.task_id);
    if (!task) return;
    const author = this.data.members.find(
      (m) => m.user_id === comment.author_id,
    );
    for (const id of mentionedIds(comment.body)) {
      if (id === comment.author_id) continue;
      if (!this.data.members.some((m) => m.user_id === id && m.active))
        continue;
      task.participant_ids = [
        ...new Set([...(task.participant_ids ?? [task.assignee_id]), id]),
      ];
      this.notifications.push({
        id: crypto.randomUUID(),
        user_id: id,
        kind: "mention",
        task_id: task.id,
        task_title: task.title,
        actor_id: comment.author_id,
        actor_name: author?.name ?? null,
        excerpt: richTextPlain(comment.body).replace(/\s+/g, " ").slice(0, 160),
        read_at: null,
        created_at: comment.created_at,
      });
    }
  }
  private setClientTeams(clientId: string, teams: string[]) {
    const company_id = this.data.companies[0].id;
    this.data.clientTeams = [
      ...this.data.clientTeams.filter((ct) => ct.client_id !== clientId),
      ...[...new Set(teams)].map((team_id) => ({
        company_id,
        client_id: clientId,
        team_id,
      })),
    ];
  }
  private setTeamPeople(
    teamId: string,
    users: string[],
    supervisors: string[],
  ) {
    const company_id = this.data.companies[0].id;
    const invalid = supervisors.some(
      (id) => !this.data.members.some((m) => m.user_id === id && m.active),
    );
    if (invalid)
      throw Error("Supervisores precisam ser pessoas ativas da empresa");
    this.data.teamMembers = [
      ...this.data.teamMembers.filter((tm) => tm.team_id !== teamId),
      ...[...new Set([...users, ...supervisors])].map((user_id) => ({
        company_id,
        team_id: teamId,
        user_id,
        supervisor: supervisors.includes(user_id),
      })),
    ];
  }
  mutate(name: string, a: Record<string, any>) {
    const id = crypto.randomUUID(),
      company_id = this.data.companies[0].id,
      now = new Date().toISOString();
    const task = this.data.tasks.find((t) => t.id === a.p_task);
    const event = (action: string, detail: Record<string, unknown> = {}) =>
      this.events.unshift({
        id: crypto.randomUUID(),
        task_id: a.p_task,
        actor_id: demoUser,
        action,
        detail,
        created_at: now,
      });
    // Mirrors start_timer / stop_timer: play and pause become comments.
    const timerComment = (taskId: string, body: string) =>
      this.comments.unshift({
        id: crypto.randomUUID(),
        company_id: this.data.companies[0].id,
        task_id: taskId,
        author_id: demoUser,
        body,
        created_at: new Date().toISOString(),
      });
    switch (name) {
      case "update_client":
      case "update_product":
      case "update_project":
      case "update_contract": {
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        if (role !== "admin" && role !== "manager")
          throw Error("Sem permissão");
        const kind = name.replace("update_", "");
        const rows =
          kind === "client"
            ? this.data.clients
            : kind === "product"
              ? this.data.products
              : kind === "project"
                ? this.data.projects
                : this.data.contracts;
        const entity = rows.find((r) => r.id === a[`p_${kind}`]);
        if (!entity) throw Error("Cadastro não encontrado");
        const changes: Record<string, unknown> = { name: a.p_name };
        if (kind === "client") {
          changes.email = a.p_email;
          if (a.p_teams) this.setClientTeams(entity.id, a.p_teams);
        }
        if (kind === "project") {
          if (
            a.p_contract !== (entity as any).contract_id &&
            this.data.tasks.some((t) => t.project_id === entity.id)
          )
            throw Error(
              "Projetos com tarefas não podem mudar de produto contratado.",
            );
          changes.due_date = a.p_due;
          changes.contract_id = a.p_contract;
          if (a.p_requires_review != null)
            changes.requires_review = a.p_requires_review;
          if (a.p_approver) changes.approver = a.p_approver;
        }
        if (kind === "contract") {
          changes.client_id = a.p_client;
          changes.product_id = a.p_product;
        }
        Object.assign(entity, changes);
        break;
      }
      case "create_client":
        this.data.clients.push({
          id,
          company_id,
          name: a.p_name,
          email: a.p_email,
          color: "#8e81bb",
          archived: false,
        });
        this.setClientTeams(id, a.p_teams ?? []);
        break;
      case "create_product":
        this.data.products.push({
          id,
          company_id,
          name: a.p_name,
          color: "#81a0be",
        });
        break;
      case "create_contract":
        this.data.contracts.push({
          id,
          company_id,
          client_id: a.p_client,
          product_id: a.p_product,
          name: a.p_name,
          archived: false,
        });
        if (a.p_team)
          this.setClientTeams(a.p_client, [
            ...this.data.clientTeams
              .filter((ct) => ct.client_id === a.p_client)
              .map((ct) => ct.team_id),
            a.p_team,
          ]);
        break;
      case "create_project":
        this.data.projects.push({
          id,
          company_id,
          contract_id: a.p_contract,
          name: a.p_name,
          due_date: a.p_due,
          archived: false,
          requires_review: a.p_requires_review ?? true,
          approver: a.p_approver ?? "creator",
        });
        break;
      case "update_member": {
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        const target = this.data.members.find((m) => m.user_id === a.p_user);
        if (!target || (role !== "admin" && role !== "manager"))
          throw Error("Sem permissão");
        if (
          role !== "admin" &&
          (target.role === "admin" || a.p_role === "admin")
        )
          throw Error("Somente administradores editam administradores.");
        if (a.p_user === demoUser && (a.p_role !== target.role || !a.p_active))
          throw Error(
            "Você não pode alterar o próprio perfil de acesso nem se desativar.",
          );
        Object.assign(target, {
          name: String(a.p_name).trim(),
          role: a.p_role,
          active: a.p_active,
        });
        const company_id = this.data.companies[0].id;
        const kept = this.data.teamMembers.filter(
          (tm) => tm.user_id === a.p_user && a.p_teams.includes(tm.team_id),
        );
        this.data.teamMembers = [
          ...this.data.teamMembers.filter((tm) => tm.user_id !== a.p_user),
          ...a.p_teams.map((team_id: string) => ({
            company_id,
            team_id,
            user_id: a.p_user,
            supervisor:
              a.p_role !== "member" &&
              !!kept.find((tm) => tm.team_id === team_id)?.supervisor,
          })),
        ];
        break;
      }
      case "update_my_profile": {
        const name = String(a.p_name ?? "").trim();
        if (name.length < 2)
          throw Error("Informe um nome de 2 a 120 caracteres.");
        this.data.members = this.data.members.map((m) =>
          m.user_id === demoUser ? { ...m, name } : m,
        );
        break;
      }
      case "set_my_avatar":
        this.data.members = this.data.members.map((m) =>
          m.user_id === demoUser ? { ...m, avatar_url: a.p_url ?? null } : m,
        );
        break;
      case "create_team":
        this.data.teams.push({ id, company_id, name: a.p_name });
        this.setTeamPeople(id, a.p_users ?? [], a.p_supervisors ?? []);
        break;
      case "update_team": {
        const team = this.data.teams.find((t) => t.id === a.p_team);
        if (!team) throw Error("Equipe não encontrada");
        team.name = a.p_name;
        this.setTeamPeople(team.id, a.p_users ?? [], a.p_supervisors ?? []);
        break;
      }
      case "create_task":
        this.data.tasks.unshift({
          id,
          company_id,
          contract_id: a.p_contract,
          project_id: a.p_project ?? null,
          team_id: a.p_team ?? null,
          parent_id: a.p_parent ?? null,
          title: a.p_title,
          description: a.p_description ?? "",
          status: "open",
          status_changed_at: now,
          priority: a.p_priority ?? "normal",
          creator_id: demoUser,
          assignee_id: a.p_assignee,
          due_date: a.p_due,
          original_due_date: a.p_due,
          start_date: a.p_start ?? null,
          estimated_minutes: a.p_estimated ?? 0,
          requires_client_approval: a.p_client_approval ?? false,
          internal_approved_by: null,
          client_approved_by: null,
          client_approval_note: null,
          delivered_at: null,
          revision: 1,
          version: 1,
          archived: false,
          created_at: now,
        });
        break;
      case "update_task": {
        if (!task) throw Error("Tarefa não encontrada");
        const callerRole = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        const isLeader = callerRole === "admin" || callerRole === "manager";
        if (task.creator_id !== demoUser && !isLeader)
          throw Error("Sem permissão para editar");
        Object.assign(task, {
          title: a.p_title,
          description: a.p_description,
          due_date: a.p_due,
          start_date: a.p_start ?? null,
          estimated_minutes: a.p_estimated,
          priority: a.p_priority,
          internal_approved_by: null,
          client_approved_by: null,
          client_approval_note: null,
          revision: task.revision + 1,
          version: task.version + 1,
          status: ["review", "done"].includes(task.status)
            ? "progress"
            : task.status,
          delivered_at: null,
        });
        event("edited");
        break;
      }
      case "transition_task": {
        if (!task) throw Error("Tarefa não encontrada");
        if (task.version !== a.p_version)
          throw Error("A tarefa mudou. Atualize.");
        // Same rules as the status menu (and public.transition_task).
        const acts = taskActions(this.data, task, demoUser);
        const from = task.status,
          statusSince = task.status_changed_at ?? task.created_at,
          fromAssignee = task.assignee_id,
          note = String(a.p_note ?? "").trim();
        const review = projectReview(
          this.data.projects.find((p) => p.id === task.project_id),
        ).required;
        const assignee: string = a.p_assignee ?? task.assignee_id;
        if (!this.data.members.some((m) => m.user_id === assignee && m.active))
          throw Error("Escolha um responsável ativo da empresa");
        let next: Status = from;
        if (a.p_action === "move") {
          if (!acts.move)
            throw Error(
              "Somente o responsável, o criador ou um gestor muda o status da tarefa",
            );
          const target: Status = a.p_status ?? from;
          if (target === "done") {
            if (review)
              throw Error(
                "Este projeto exige validação: a entrega é aprovada por quem valida",
              );
            task.internal_approved_by = demoUser;
            next = "review";
          } else if (workingStatuses.includes(target)) next = target;
          else throw Error("Status inválido");
          if (target === from && assignee === task.assignee_id)
            throw Error("Escolha outro status ou outro responsável");
          if (next !== from && ["returned", "rejected"].includes(next) && !note)
            throw Error(
              next === "returned"
                ? "Informe quais informações faltam"
                : "Descreva a alteração solicitada",
            );
        } else if (a.p_action === "approve_internal") {
          if (!acts.approveInternal) throw Error("Sem permissão para aprovar");
          if (!note) throw Error("Informe as observações da validação");
          task.internal_approved_by = demoUser;
        } else if (a.p_action === "approve_client") {
          if (!acts.approveClient)
            throw Error("Sem permissão para registrar aprovação");
          if (!note) throw Error("Informe quem aprovou e a evidência");
          task.client_approved_by = demoUser;
          task.client_approval_note = a.p_note;
        } else if (a.p_action === "reopen") {
          if (acts.reopen !== true) throw Error("Sem permissão para reabrir");
          if (!note) throw Error("Informe o motivo");
          next = a.p_status ?? "progress";
          if (!workingStatuses.includes(next)) throw Error("Status inválido");
        } else throw Error("Ação inválida");
        if (["move", "reopen"].includes(a.p_action) && next !== "review") {
          task.internal_approved_by = null;
          task.client_approved_by = null;
          task.client_approval_note = null;
        }
        if (
          a.p_action === "reopen" ||
          (next !== from && ["returned", "rejected"].includes(next))
        )
          task.revision++;
        if (
          next === "review" &&
          task.internal_approved_by &&
          (!task.requires_client_approval || task.client_approved_by)
        )
          next = "done";
        if (next !== from) task.status_changed_at = now;
        task.status = next;
        task.assignee_id = assignee;
        task.participant_ids = [
          ...new Set([...(task.participant_ids ?? [fromAssignee]), assignee]),
        ];
        task.delivered_at = next === "done" ? now : null;
        task.version++;
        event(a.p_action, {
          from,
          to: next,
          note: a.p_note,
          assignee_from: fromAssignee,
          assignee_to: assignee,
          status_since: statusSince,
        });
        if (note) {
          let label =
            a.p_action === "approve_internal"
              ? "Aprovada na validação"
              : a.p_action === "approve_client"
                ? "Aprovação do cliente registrada"
                : a.p_action === "reopen"
                  ? `Tarefa reaberta · ${statuses[next].label}`
                  : next !== from
                    ? statuses[next].label
                    : "Responsável alterado";
          if (assignee !== fromAssignee)
            label += ` · Responsável: ${
              this.data.members.find((m) => m.user_id === assignee)?.name ?? "—"
            }`;
          this.comments.unshift({
            id: crypto.randomUUID(),
            company_id: task.company_id,
            task_id: task.id,
            author_id: demoUser,
            body: transitionComment(label, a.p_note),
            created_at: now,
          });
          this.mentionsIn(this.comments[0]);
        }
        break;
      }
      case "add_comment":
        this.comments.unshift({
          id,
          company_id,
          task_id: a.p_task,
          author_id: demoUser,
          body: a.p_body,
          created_at: now,
        });
        this.mentionsIn(this.comments[0]);
        break;
      case "start_timer":
        {
          const active = this.data.hours.find(
            (h) => h.user_id === demoUser && !h.ended_at,
          );
          if (active && active.task_id === a.p_task) return active.id;
          if (active) {
            active.ended_at = now;
            timerComment(active.task_id, pauseComment(active, true));
          }
        }
        timerComment(a.p_task, transitionComment("Iniciou o trabalho", ""));
        this.data.hours.unshift({
          id,
          company_id,
          task_id: a.p_task,
          user_id: demoUser,
          started_at: now,
          ended_at: null,
          note: "",
          source: "timer",
        });
        break;
      case "stop_timer": {
        const h = this.data.hours.find((h) => h.id === a.p_entry);
        if (h && !h.ended_at) {
          h.ended_at = now;
          timerComment(h.task_id, pauseComment(h, false));
        }
        break;
      }
      case "log_time":
        if (Date.parse(a.p_end) <= Date.parse(a.p_start))
          throw Error("Período inválido");
        this.data.hours.unshift({
          id,
          company_id,
          task_id: a.p_task,
          user_id: demoUser,
          started_at: a.p_start,
          ended_at: a.p_end,
          note: a.p_note,
          source: "manual",
        });
        break;
      case "invite_user": {
        const uid = crypto.randomUUID();
        const role = String(a.p_role ?? "member") as
          "admin" | "manager" | "member";
        const name = String(a.p_name ?? "").trim();
        const email = String(a.p_email ?? "")
          .trim()
          .toLowerCase();
        this.data.members.push({
          user_id: uid,
          company_id,
          name,
          email,
          role,
          active: true,
        });
        const teams = Array.isArray(a.p_teams) ? (a.p_teams as string[]) : [];
        for (const tid of teams) {
          this.data.teamMembers.push({
            company_id,
            team_id: tid,
            user_id: uid,
          });
        }
        break;
      }
      case "reset_password": {
        const targetId = String(a.p_user ?? "");
        const member = this.data.members.find((m) => m.user_id === targetId);
        if (!member) throw Error("Usuário não encontrado.");
        if (a.p_mode === "set_password") {
          const pwd = String(a.p_new_password ?? "").trim();
          if (pwd.length < 8)
            throw Error("A nova senha deve ter no mínimo 8 caracteres.");
          return { success: true, message: "Senha redefinida com sucesso." };
        }
        return {
          success: true,
          link: "https://mavi.maso.app.br/?reset=demo-token",
          message: `Link de recuperação enviado para ${member.email || member.name}.`,
        };
      }
      case "update_user_email": {
        const targetId = String(a.p_user ?? "");
        const newEmail = String(a.p_new_email ?? "")
          .trim()
          .toLowerCase();
        if (!newEmail || !/^\S+@\S+\.\S+$/.test(newEmail))
          throw Error("Informe um e-mail válido.");
        const member = this.data.members.find((m) => m.user_id === targetId);
        if (!member) throw Error("Usuário não encontrado.");
        member.email = newEmail;
        break;
      }
      default:
        throw Error("Operação indisponível na demonstração");
    }
    this.data = {
      ...this.data,
      tasks: [...this.data.tasks],
      hours: [...this.data.hours],
      members: [...this.data.members],
      teamMembers: [...this.data.teamMembers],
    };
    return id;
  }
}

/** Mirrors mavi_private.session_label: "1h 05min", "25min", "40s". */
export function sessionLabel(from: string, to: string) {
  const s = Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}min`;
}
function pauseComment(
  entry: { started_at: string; ended_at: string | null },
  automatic: boolean,
) {
  return transitionComment(
    automatic
      ? "Pausou o trabalho (ao iniciar outra tarefa)"
      : "Pausou o trabalho",
    `Sessão de ${sessionLabel(entry.started_at, entry.ended_at!)}`,
  );
}
