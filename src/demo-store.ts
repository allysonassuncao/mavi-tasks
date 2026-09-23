import { demoSnapshot, demoUser } from "./demo";
import {
  type Snapshot,
  type Task,
  type Comment,
  type Attachment,
  type TaskEvent,
} from "./types";
export class DemoStore {
  data: Snapshot = demoSnapshot();
  comments: Comment[] = [];
  attachments: Attachment[] = [];
  events: TaskEvent[] = [];
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
        if (kind === "client") changes.email = a.p_email;
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
          this.data.contractTeams.push({
            company_id,
            contract_id: id,
            team_id: a.p_team,
          });
        break;
      case "create_project":
        this.data.projects.push({
          id,
          company_id,
          contract_id: a.p_contract,
          name: a.p_name,
          due_date: a.p_due,
          archived: false,
        });
        break;
      case "create_team":
        this.data.teams.push({ id, company_id, name: a.p_name });
        for (const user_id of a.p_users ?? [])
          this.data.teamMembers.push({ company_id, team_id: id, user_id });
        break;
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
        const callerRole = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        const isLeader = callerRole === "admin" || callerRole === "manager";
        const approval = [
          "approve_internal",
          "approve_client",
          "reject",
          "reopen",
        ].includes(a.p_action);
        if (approval && !isLeader && task.creator_id !== demoUser)
          throw Error("Apenas o criador ou gestor pode aprovar");
        const from = task.status;
        if (
          ["return", "reject", "reopen"].includes(a.p_action) &&
          !a.p_note?.trim()
        )
          throw Error("Informe o motivo");
        if (a.p_action === "approve_client" && !a.p_note?.trim())
          throw Error("Registre a evidência de aprovação");
        if (
          a.p_action === "start" ||
          a.p_action === "reject" ||
          a.p_action === "reopen"
        )
          task.status = "progress";
        if (a.p_action === "return") task.status = "returned";
        if (a.p_action === "submit") task.status = "review";
        if (a.p_action === "approve_internal")
          task.internal_approved_by = demoUser;
        if (a.p_action === "approve_client") {
          task.client_approved_by = demoUser;
          task.client_approval_note = a.p_note;
        }
        if (["return", "reject", "reopen"].includes(a.p_action)) {
          task.internal_approved_by = null;
          task.client_approved_by = null;
          task.revision++;
        }
        if (
          task.status === "review" &&
          task.internal_approved_by &&
          (!task.requires_client_approval || task.client_approved_by)
        )
          task.status = "done";
        task.delivered_at = task.status === "done" ? now : null;
        task.version++;
        event(a.p_action, { from, to: task.status, note: a.p_note });
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
        break;
      case "start_timer":
        {
          const active = this.data.hours.find(
            (h) => h.user_id === demoUser && !h.ended_at,
          );
          if (active && active.task_id === a.p_task) return active.id;
          if (active) active.ended_at = now;
        }
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
        if (h) h.ended_at = now;
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
