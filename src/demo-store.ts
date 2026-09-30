import { demoSnapshot, demoUser } from "./demo";
import {
  dateKey,
  nextRecurrence,
  projectReview,
  taskActions,
  teamAssignee,
} from "./domain";
import {
  customFieldsError,
  customKey,
  isEmpty,
  templateFieldsFor,
  teamTemplateFields,
} from "./templateFields";
import { mentionedIds, richTextPlain, transitionComment } from "./rich-text";
import {
  type Snapshot,
  type Status,
  type TaskCustomField,
  type Task,
  type Comment,
  type Attachment,
  type TaskEvent,
  type TaskRecurrence,
  type AppNotification,
  statuses,
  workingStatuses,
} from "./types";
import { MEMBER_OPT_IN, MODULES } from "./modules";
import { canChangeDue, dueChangeError, dueReasonError } from "./task-due";
import type { TaskView } from "./api";
import type { BulkChange, BulkItem, BulkResult, BulkUndo } from "./task-bulk";
import {
  addBusinessDays,
  canManageDueScope,
  nationalHoliday,
  suggestDue,
} from "./dueRules";

/** N business days after (or before, when negative) — mavi_private.add_business_days. */
/** Where a task's due rule starts counting: its start or the day it was created. */
const dueBase = (t: Task) => t.start_date || dateKey(new Date(t.created_at));
export class DemoStore {
  data: Snapshot = demoSnapshot();
  comments: Comment[] = [];
  attachments: Attachment[] = [];
  events: TaskEvent[] = [];
  /** Repetitions set up in the demo (it never opens their copies). */
  recurrences: TaskRecurrence[] = [];
  /** The demo person's saved views of the task list. */
  views: TaskView[] = [];
  /** Bulk edits that can still be undone: each task as it was before. */
  private bulkOps = new Map<
    string,
    { before: Map<string, Task>; afterVersion: Map<string, number> }
  >();
  /**
   * Mirrors public.bulk_update_tasks: each task goes through the same rules
   * as one by one (transition_task for responsible and status, the edit
   * permission for due dates). The review runs it all and puts it back.
   */
  /** Mirrors mavi_private.log_due_change: the history line with the reason. */
  private dueChanged(t: Task, old: string, reason: string, source: string) {
    this.events.unshift({
      id: crypto.randomUUID(),
      task_id: t.id,
      actor_id: demoUser,
      action: "due_changed",
      detail: { old_due: old, new_due: t.due_date, reason: reason.trim(), source },
      created_at: new Date().toISOString(),
    });
  }
  bulk(ids: string[], change: BulkChange, preview: boolean): BulkResult {
    // Every due date change asks why (migration 20270110090000).
    if (change.kind === "due" || change.kind === "shift" || change.kind === "rule") {
      const problem = dueReasonError(change.reason);
      if (problem) throw Error(problem);
    }
    const saved = preview
      ? {
          tasks: structuredClone(this.data.tasks),
          events: [...this.events],
          comments: [...this.comments],
          hours: structuredClone(this.data.hours),
        }
      : null;
    const me = this.data.members.find((m) => m.user_id === demoUser);
    const leader = me?.role === "admin" || me?.role === "manager";
    const name = (id: string) =>
      this.data.members.find((m) => m.user_id === id)?.name ?? "—";
    const team = this.data.teams.find(
      (t) => "value" in change && t.id === change.value,
    );
    const results: BulkItem[] = [];
    const before = new Map<string, Task>();
    const afterVersion = new Map<string, number>();
    for (const id of [...new Set(ids)]) {
      const t = this.data.tasks.find((x) => x.id === id);
      if (!t) {
        results.push({ id, ok: false, reason: "Tarefa não encontrada" });
        continue;
      }
      const was = structuredClone(t);
      let reason: string | null = null;
      try {
        const move = (status: Status, assignee: string | null, note = "") =>
          this.mutate("transition_task", {
            p_task: t.id,
            p_version: t.version,
            p_action: "move",
            p_note: note,
            p_status: status,
            p_assignee: assignee,
          });
        if (change.kind === "assignee") {
          if (t.assignee_id === change.value)
            reason = `Já está com ${name(change.value)}`;
          else move(t.status, change.value);
        } else if (change.kind === "team") {
          const client = this.data.contracts.find(
            (k) => k.id === t.contract_id,
          )?.client_id;
          if (
            !this.data.clientTeams.some(
              (ct) => ct.client_id === client && ct.team_id === change.value,
            )
          )
            reason = `A equipe ${team?.name ?? ""} não atende este cliente`;
          else {
            const pick = teamAssignee(this.data, change.value)?.user_id;
            if (!pick)
              throw Error("Esta equipe não tem ninguém ativo para receber tarefas.");
            if (pick === t.assignee_id)
              reason = `Continua com ${name(pick)}, quem tem menos tarefas na equipe`;
            else {
              move(t.status, pick);
              t.team_id = change.value;
            }
          }
        } else if (change.kind === "status") {
          if (t.status === change.value)
            reason = `Já está em ${statuses[change.value].label}`;
          else move(change.value, null, change.note ?? "");
        } else if (!canChangeDue(this.data, t, demoUser))
          reason = "Sem permissão para mudar o prazo desta tarefa";
        else {
          // Mirrors the due branch of public.bulk_update_tasks.
          const byRule = change.kind === "rule";
          const rule = suggestDue(this.data, {
            contract: t.contract_id,
            project: t.project_id,
            team: t.team_id,
            assignee: t.assignee_id,
            base: dueBase(t),
            approval: t.requires_client_approval,
          });
          const due =
            change.kind === "due"
              ? change.value
              : change.kind === "shift"
                ? addBusinessDays(this.data.calendarDays, t.due_date, change.value)
                : (rule?.due ?? t.due_date);
          const why = change.kind === "rule" ? "" : change.reason;
          const short = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
          if (byRule && !rule)
            reason = "Nenhuma regra de prazo vale para esta tarefa";
          else if (byRule && due === t.due_date && t.due_manual === false)
            reason = "Já está no prazo da regra";
          else if (!byRule && due === t.due_date) reason = "Já tem esse prazo";
          else if (t.start_date && due < t.start_date)
            reason = `O prazo ficaria antes do início (${short(t.start_date)})`;
          else if (
            !byRule &&
            rule?.min &&
            due < rule.min &&
            due < t.due_date &&
            !why
          )
            reason = `Fica antes do mínimo da regra (${short(rule.min)}): informe o motivo`;
          else {
            const tight = !byRule && !!rule?.min && due < rule.min;
            t.due_tight_reason = tight
              ? (due < t.due_date ? why : "") || t.due_tight_reason || null
              : null;
            const old = t.due_date;
            t.due_date = due;
            t.due_manual = !byRule;
            t.due_rule_id = byRule ? rule!.rule.id : null;
            t.version++;
            if (old !== due) this.dueChanged(t, old, change.reason, "bulk");
          }
        }
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
      }
      if (!reason) {
        before.set(t.id, was);
        afterVersion.set(t.id, t.version);
      }
      const side = (x: Task) => ({
        status: x.status,
        assignee_id: x.assignee_id,
        due_date: x.due_date,
      });
      results.push({
        id: t.id,
        title: t.title,
        contract_id: t.contract_id,
        parent_id: t.parent_id,
        ok: !reason,
        reason,
        before: side(was),
        after: side(t),
      });
    }
    const applied = results.filter((r) => r.ok).length;
    if (saved) {
      this.data.tasks = saved.tasks;
      this.events = saved.events;
      this.comments = saved.comments;
      this.data.hours = saved.hours;
      return { preview: true, applied, results };
    }
    const operation = applied ? crypto.randomUUID() : null;
    if (operation) this.bulkOps.set(operation, { before, afterVersion });
    return { preview: false, operation, applied, results };
  }
  undoBulk(operation: string): BulkUndo {
    const op = this.bulkOps.get(operation);
    if (!op) throw Error("Esta alteração já foi desfeita");
    this.bulkOps.delete(operation);
    let restored = 0,
      kept = 0;
    for (const [id, was] of op.before) {
      const i = this.data.tasks.findIndex((t) => t.id === id);
      if (i < 0 || this.data.tasks[i].version !== op.afterVersion.get(id)) {
        kept++;
        continue;
      }
      this.data.tasks[i] = { ...was, version: this.data.tasks[i].version + 1 };
      restored++;
    }
    return { restored, kept };
  }
  /** Everyone's notifications (the demo person sees only theirs). */
  notifications: (AppNotification & {
    user_id: string;
    comment_id?: string;
  })[] = [];
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
      .map((n) => ({
        ...n,
        client_id:
          n.client_id ??
          this.data.contracts.find(
            (k) =>
              k.id ===
              this.data.tasks.find((t) => t.id === n.task_id)?.contract_id,
          )?.client_id ??
          null,
      }))
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
        comment_id: comment.id,
      });
    }
  }
  /** Mirrors mavi_private.comment_replies: tells the conversation. */
  private repliesTo(reply: Comment) {
    const task = this.data.tasks.find((t) => t.id === reply.task_id);
    if (!task || !reply.parent_id) return;
    const author = this.data.members.find((m) => m.user_id === reply.author_id);
    const told = new Set(
      this.notifications
        .filter((n) => n.comment_id === reply.id)
        .map((n) => n.user_id),
    );
    for (const c of this.comments) {
      if (c.id !== reply.parent_id && c.parent_id !== reply.parent_id) continue;
      if (c.author_id === reply.author_id || told.has(c.author_id)) continue;
      if (!this.data.members.some((m) => m.user_id === c.author_id && m.active))
        continue;
      told.add(c.author_id);
      this.notifications.push({
        id: crypto.randomUUID(),
        user_id: c.author_id,
        kind: "reply",
        task_id: task.id,
        task_title: task.title,
        actor_id: reply.author_id,
        actor_name: author?.name ?? null,
        excerpt: richTextPlain(reply.body).replace(/\s+/g, " ").slice(0, 160),
        read_at: null,
        created_at: reply.created_at,
        comment_id: reply.id,
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
    const statusBefore = task?.status;
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
        if (kind === "product" && a.p_color) changes.color = a.p_color;
        if (kind === "product" && a.p_task_project_field != null)
          changes.task_project_field = a.p_task_project_field;
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
      case "set_company_logo": {
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        if (role !== "admin") throw Error("Sem permissão");
        this.data.companies = this.data.companies.map((c) =>
          c.id === a.p_company ? { ...c, logo_url: a.p_url ?? null } : c,
        );
        break;
      }
      case "remove_contract": {
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        if (role !== "admin" && role !== "manager")
          throw Error("Sem permissão");
        const k = a.p_contract;
        if (!this.data.contracts.some((x) => x.id === k))
          throw Error("Cadastro não encontrado");
        const history =
          this.data.projects.some((p) => p.contract_id === k) ||
          this.data.tasks.some((t) => t.contract_id === k);
        this.data.contracts = history
          ? this.data.contracts.map((x) =>
              x.id === k ? { ...x, archived: true } : x,
            )
          : this.data.contracts.filter((x) => x.id !== k);
        return history ? "archived" : "deleted";
      }
      case "set_client_archived": {
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        if (role !== "admin" && role !== "manager")
          throw Error("Sem permissão");
        if (!this.data.clients.some((c) => c.id === a.p_client))
          throw Error("Cadastro não encontrado");
        // A new list, so views filtering by status recompute.
        this.data.clients = this.data.clients.map((c) =>
          c.id === a.p_client ? { ...c, archived: !!a.p_archived } : c,
        );
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
      case "set_member_pages": {
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        const target = this.data.members.find((m) => m.user_id === a.p_user);
        if (role !== "admin")
          throw Error(
            "Somente administradores escolhem os módulos de cada pessoa.",
          );
        if (!target) throw Error("Usuário não encontrado na empresa");
        const hidden = [...new Set<string>(a.p_hidden ?? [])].sort();
        if (hidden.some((h) => !MODULES.some((m) => m.id === h)))
          throw Error("Módulo inválido");
        // A collaborator's opt-in modules are kept as the ones turned on
        // (set_member_pages in migration 20270105090000).
        if (target.role === "member") {
          const optIn = MEMBER_OPT_IN as readonly string[];
          target.hidden_pages = hidden.filter((h) => !optIn.includes(h));
          target.shown_pages = optIn.filter((h) => !hidden.includes(h));
        } else target.hidden_pages = hidden;
        break;
      }
      case "set_member_mcp": {
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        const target = this.data.members.find((m) => m.user_id === a.p_user);
        if (role !== "admin")
          throw Error("Somente administradores liberam o MCP para cada pessoa.");
        if (!target) throw Error("Usuário não encontrado na empresa");
        if (!["default", "on", "off"].includes(a.p_access))
          throw Error("Opção inválida");
        target.mcp_access = a.p_access;
        break;
      }
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
      case "save_suggestion_settings": {
        const contract = this.data.contracts.find((c) => c.id === a.p_contract);
        if (
          !this.data.clientTeams.some(
            (ct) =>
              ct.client_id === contract?.client_id && ct.team_id === a.p_team,
          )
        )
          throw Error("A equipe de P&D precisa atender o cliente escolhido");
        this.data.suggestionSettings = [
          {
            company_id,
            team_id: a.p_team,
            contract_id: a.p_contract,
            project_id: a.p_project ?? null,
          },
        ];
        break;
      }
      case "submit_suggestion":
      case "create_task": {
        if (name === "submit_suggestion") {
          // Mirrors public.submit_suggestion: a task for P&D, where the
          // settings say, with no template field asked up front.
          const s = this.data.suggestionSettings?.[0];
          if (!s)
            throw Error(
              "Sugestões ainda não configuradas: um gestor precisa escolher a equipe de P&D",
            );
          if (
            !this.data.teamMembers.some(
              (tm) => tm.team_id === s.team_id && tm.user_id === a.p_assignee,
            )
          )
            throw Error("Escolha um responsável da equipe de P&D");
          const due = new Date();
          due.setDate(due.getDate() + (a.p_kind === "bug" ? 2 : 7));
          Object.assign(a, {
            p_contract: s.contract_id,
            p_project: s.project_id,
            p_team: s.team_id,
            p_priority: a.p_kind === "bug" ? "high" : "normal",
            p_due: dateKey(due),
            p_custom: {},
          });
        }
        // Mirrors public.create_task: a task sent to a team goes to its
        // active member with the fewest open tasks (supervisors only when
        // there is nobody else), and gets the fields of that team's templates.
        const byTeam = name === "create_task" && !a.p_assignee;
        let assignee: string = a.p_assignee;
        if (byTeam) {
          if (!a.p_team) throw Error("Escolha um responsável ou uma equipe");
          const picked = teamAssignee(this.data, a.p_team);
          if (!picked)
            throw Error(
              "Esta equipe não tem ninguém ativo para receber a tarefa.",
            );
          assignee = picked.user_id;
        }
        // The templates that apply add their fields, and the required ones
        // must be filled in.
        const fields = byTeam
          ? teamTemplateFields(this.data, a.p_contract, a.p_team)
          : templateFieldsFor(this.data, a.p_contract, assignee);
        const problem =
          name === "create_task" && customFieldsError(fields, a.p_custom ?? {});
        if (problem) throw Error(problem);
        // Mirrors mavi_private.choose_due: without p_due_manual, the rule's
        // date for whoever receives the task.
        const dueRule =
          name === "create_task"
            ? suggestDue(this.data, {
                contract: a.p_contract,
                project: a.p_project,
                team: a.p_team,
                assignee,
                base: a.p_start || dateKey(),
                approval: a.p_client_approval,
              })
            : null;
        const dueManual = name !== "create_task" || (a.p_due_manual ?? true);
        // Prazo inteligente: the demo has no history, so the form's date stands.
        const dueSmart = name === "create_task" && !dueManual && !!a.p_due_smart;
        const due: string =
          dueSmart ? a.p_due : !dueManual && dueRule ? dueRule.due : a.p_due;
        if (!due) throw Error("Escolha o prazo");
        const tight = dueManual && !!dueRule?.min && due < dueRule.min;
        if (tight && String(a.p_due_reason ?? "").trim().length < 5)
          throw Error(
            `Este prazo fica antes do mínimo da regra (${dueRule!.min!.split("-").reverse().join("/")}). Explique o motivo para continuar.`,
          );
        // The main task never ends before a subtask.
        const parentTask = this.data.tasks.find((t) => t.id === a.p_parent);
        if (parentTask && parentTask.status !== "done" && parentTask.due_date < due) {
          parentTask.due_date = due;
          parentTask.version++;
        }
        this.data.tasks.unshift({
          due_manual: dueManual,
          due_smart: dueSmart,
          due_rule_id: !dueManual && dueRule ? dueRule.rule.id : null,
          due_tight_reason: tight ? String(a.p_due_reason).trim() : null,
          custom_fields: fillDemoFields(fields, a.p_custom ?? {}),
          id,
          company_id,
          contract_id: a.p_contract,
          project_id: a.p_project ?? null,
          team_id: a.p_team ?? null,
          parent_id: a.p_parent ?? null,
          title: a.p_title,
          description: a.p_description ?? "",
          status: "progress",
          status_changed_at: now,
          priority: a.p_priority ?? "normal",
          creator_id: demoUser,
          assignee_id: assignee,
          due_date: due,
          original_due_date: due,
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
        // Mirrors mavi_private.start_recurrence.
        if (name === "create_task" && a.p_repeat) {
          const today = dateKey();
          const recurrence: TaskRecurrence = {
            id: crypto.randomUUID(),
            frequency: a.p_repeat,
            next_run: nextRecurrence(a.p_repeat, today, today),
            active: true,
            creator_id: demoUser,
            copies: 0,
            last_error: null,
          };
          this.recurrences.push(recurrence);
          this.data.tasks[0].recurrence_id = recurrence.id;
          this.events.unshift({
            id: crypto.randomUUID(),
            task_id: id,
            actor_id: demoUser,
            action: "recurrence_started",
            detail: { frequency: a.p_repeat },
            created_at: now,
          });
        }
        break;
      }
      case "stop_task_recurrence": {
        // Mirrors public.stop_task_recurrence.
        const r = this.recurrences.find((x) => x.id === task?.recurrence_id);
        if (!r) throw Error("Esta tarefa não se repete");
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        if (r.creator_id !== demoUser && role !== "admin" && role !== "manager")
          throw Error(
            "Só quem programou a repetição ou um gestor pode pará-la",
          );
        if (r.active) {
          r.active = false;
          event("recurrence_stopped");
        }
        break;
      }
      case "set_task_due": {
        // Mirrors public.set_task_due (migration 20270110090000): only the
        // date changes; approvals and status stay.
        if (!task || task.archived || !canChangeDue(this.data, task, demoUser))
          throw Error("Sem permissão para mudar o prazo desta tarefa");
        if (task.version !== a.p_version)
          throw Error("A tarefa mudou. Atualize antes de continuar.");
        const problem = dueChangeError(task, a.p_due, String(a.p_reason ?? ""));
        if (problem) throw Error(problem);
        const rule = suggestDue(this.data, {
          contract: task.contract_id,
          project: task.project_id,
          team: task.team_id,
          assignee: task.assignee_id,
          base: dueBase(task),
          approval: task.requires_client_approval,
        });
        const old = task.due_date;
        const tight = !!rule?.min && a.p_due < rule.min;
        task.due_tight_reason = tight
          ? (a.p_due < old ? String(a.p_reason).trim() : task.due_tight_reason) || null
          : null;
        task.due_date = a.p_due;
        task.due_manual = true;
        task.due_rule_id = null;
        task.due_smart = false;
        task.version++;
        this.dueChanged(task, old, String(a.p_reason), "task");
        break;
      }
      case "set_task_custom_fields": {
        if (!task) throw Error("Tarefa não encontrada");
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        if (
          task.creator_id !== demoUser &&
          role !== "admin" &&
          role !== "manager"
        )
          throw Error("Sem permissão");
        if (task.version !== a.p_version)
          throw Error("A tarefa mudou. Atualize antes de continuar.");
        const fields = task.custom_fields ?? [];
        const problem = customFieldsError(fields, a.p_values ?? {});
        if (problem) throw Error(problem);
        task.custom_fields = fillDemoFields(fields, a.p_values ?? {});
        task.version++;
        event("fields_edited");
        break;
      }
      case "save_task_template": {
        const role = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        if (role !== "admin" && role !== "manager")
          throw Error(
            "Somente administradores e gestores configuram templates",
          );
        if (!a.p_product && !a.p_team)
          throw Error("Escolha um produto, uma equipe ou os dois.");
        const template = {
          id: a.p_id ?? id,
          company_id,
          name: String(a.p_name).trim(),
          product_id: a.p_product ?? null,
          team_id: a.p_team ?? null,
          fields: a.p_fields,
          active: a.p_active ?? true,
        };
        this.data.taskTemplates = a.p_id
          ? this.data.taskTemplates.map((t) => (t.id === a.p_id ? template : t))
          : [...this.data.taskTemplates, template];
        return template.id;
      }
      case "save_task_due_rule": {
        // Mirrors public.save_task_due_rule.
        const scope = {
          project_id: a.p_project ?? null,
          client_id: a.p_project ? null : (a.p_client ?? null),
          product_id: a.p_project ? null : (a.p_product ?? null),
          team_id: a.p_team ?? null,
          user_id: a.p_user ?? null,
        };
        const role = this.data.members.find((m) => m.user_id === demoUser)?.role;
        if (role !== "admin" && role !== "manager")
          throw Error("Somente administradores e gestores configuram prazos");
        const old = (this.data.dueRules ?? []).find((r) => r.id === a.p_id);
        if (
          !canManageDueScope(this.data, demoUser, scope) ||
          (old && !canManageDueScope(this.data, demoUser, old))
        )
          throw Error(
            "Gestores configuram só regras das suas equipes, dos clientes que elas atendem e das pessoas delas",
          );
        if (a.p_min != null && (a.p_min < 0 || a.p_min > a.p_days))
          throw Error(`O mínimo vai de 0 até o próprio prazo (${a.p_days} dias úteis)`);
        const same = (this.data.dueRules ?? []).find(
          (r) =>
            r.id !== a.p_id &&
            (Object.keys(scope) as (keyof typeof scope)[]).every((k) => r[k] === scope[k]),
        );
        if (same) throw Error("Já existe uma regra para essa mesma combinação");
        const saved = {
          id: a.p_id ?? id,
          company_id,
          ...scope,
          business_days: a.p_days,
          min_days: a.p_min ?? null,
          approval_days: a.p_approval_days ?? 0,
          active: a.p_active ?? true,
          created_by: old?.created_by ?? demoUser,
        };
        this.data.dueRules = old
          ? (this.data.dueRules ?? []).map((r) => (r.id === old.id ? saved : r))
          : [...(this.data.dueRules ?? []), saved];
        return saved.id;
      }
      case "delete_task_due_rule":
        this.data.dueRules = (this.data.dueRules ?? []).filter(
          (r) => r.id !== a.p_rule,
        );
        break;
      case "save_calendar_day": {
        const role = this.data.members.find((m) => m.user_id === demoUser)?.role;
        if (role !== "admin")
          throw Error("Somente administradores configuram o calendário da empresa");
        if (a.p_kind === "workday" && !nationalHoliday(a.p_day))
          throw Error("Só dá para marcar como dia de trabalho um feriado nacional");
        if ((this.data.calendarDays ?? []).some((c) => c.day === a.p_day && c.id !== a.p_id))
          throw Error("Este dia já está no calendário da empresa");
        const day = {
          id: a.p_id ?? id,
          company_id,
          day: a.p_day,
          name: String(a.p_name).trim(),
          kind: a.p_kind,
          yearly: !!a.p_yearly,
        };
        this.data.calendarDays = [
          ...(this.data.calendarDays ?? []).filter((c) => c.id !== day.id),
          day,
        ].sort((x, y) => (x.day < y.day ? -1 : 1));
        return day.id;
      }
      case "set_company_work_minutes": {
        const role = this.data.members.find((m) => m.user_id === demoUser)?.role;
        if (role !== "admin")
          throw Error("Somente administradores mudam a jornada da empresa");
        this.data.companies = this.data.companies.map((c) =>
          c.id === a.p_company ? { ...c, work_minutes: a.p_minutes } : c,
        );
        break;
      }
      case "set_company_smart_due": {
        const role = this.data.members.find((m) => m.user_id === demoUser)?.role;
        if (role !== "admin")
          throw Error("Somente administradores mudam o prazo inteligente");
        this.data.companies = this.data.companies.map((c) =>
          c.id === a.p_company ? { ...c, smart_due: a.p_mode } : c,
        );
        break;
      }
      case "set_member_workload": {
        // Mirrors public.set_member_workload.
        if (!canManageDueScope(this.data, demoUser, { project_id: null, client_id: null, team_id: null, user_id: a.p_user }))
          throw Error("Gestores mudam só a jornada das pessoas das suas equipes");
        const days = a.p_days?.length ? [...new Set<number>(a.p_days)].sort() : null;
        this.data.members = this.data.members.map((m) =>
          m.user_id === a.p_user
            ? { ...m, work_minutes: a.p_minutes ?? null, work_days: days?.length === 5 ? null : days }
            : m,
        );
        break;
      }
      case "save_member_absence": {
        // Mirrors public.save_member_absence.
        if (!canManageDueScope(this.data, demoUser, { project_id: null, client_id: null, team_id: null, user_id: a.p_user }))
          throw Error("Gestores registram só ausências das pessoas das suas equipes");
        if (a.p_ends < a.p_starts) throw Error("O último dia vem antes do primeiro");
        if (
          (this.data.absences ?? []).some(
            (x) => x.user_id === a.p_user && x.id !== a.p_id && x.starts_on <= a.p_ends && x.ends_on >= a.p_starts,
          )
        )
          throw Error("Já há uma ausência dessa pessoa nesse período");
        const absence = {
          id: a.p_id ?? id,
          company_id,
          user_id: a.p_user,
          starts_on: a.p_starts,
          ends_on: a.p_ends,
          kind: a.p_kind,
        };
        this.data.absences = [
          ...(this.data.absences ?? []).filter((x) => x.id !== absence.id),
          absence,
        ];
        return {
          id: absence.id,
          open_tasks: this.data.tasks.filter(
            (t) =>
              t.assignee_id === a.p_user &&
              t.status !== "done" &&
              !t.archived &&
              t.due_date >= a.p_starts &&
              t.due_date <= a.p_ends,
          ).length,
        };
      }
      case "apply_replan": {
        // Mirrors public.apply_replan (the move goes through transition_task).
        if ((a.p_items as { due?: string | null }[]).some((i) => i.due)) {
          const problem = dueReasonError(a.p_reason);
          if (problem) throw Error(problem);
        }
        const results = (a.p_items as { task: string; assignee?: string | null; due?: string | null }[]).map((i) => {
          const t = this.data.tasks.find((x) => x.id === i.task);
          if (!t || t.status === "done") return { task_id: i.task, ok: false, reason: "Tarefa não encontrada ou já entregue" };
          try {
            if (i.assignee && i.assignee !== t.assignee_id)
              this.mutate("transition_task", {
                p_task: t.id,
                p_version: t.version,
                p_action: "move",
                p_note: "",
                p_status: t.status,
                p_assignee: i.assignee,
              });
            if (i.due && i.due !== t.due_date) {
              const old = t.due_date;
              t.due_date = i.due;
              t.due_manual = true;
              t.due_rule_id = null;
              t.version++;
              this.dueChanged(t, old, a.p_reason, "replan");
            }
            return { task_id: t.id, ok: true, reason: null };
          } catch (e) {
            return { task_id: t.id, ok: false, reason: (e as Error).message };
          }
        });
        return { applied: results.filter((r) => r.ok).length, results };
      }
      case "delete_member_absence":
        this.data.absences = (this.data.absences ?? []).filter(
          (x) => x.id !== a.p_id,
        );
        break;
      case "delete_calendar_day":
        this.data.calendarDays = (this.data.calendarDays ?? []).filter(
          (c) => c.id !== a.p_id,
        );
        break;
      case "delete_task_template":
        this.data.taskTemplates = this.data.taskTemplates.filter(
          (t) => t.id !== a.p_template,
        );
        break;
      case "update_task": {
        if (!task) throw Error("Tarefa não encontrada");
        const callerRole = this.data.members.find(
          (m) => m.user_id === demoUser,
        )?.role;
        const isLeader = callerRole === "admin" || callerRole === "manager";
        if (task.creator_id !== demoUser && !isLeader)
          throw Error("Sem permissão para editar");
        // Mirrors public.update_task: another client takes the subtasks along.
        let moved: Record<string, unknown> = {};
        if (a.p_contract && a.p_contract !== task.contract_id) {
          if (task.parent_id)
            throw Error(
              "Subtarefa fica no cliente da tarefa principal. Troque o cliente da principal.",
            );
          const label = (id: string) => {
            const k = this.data.contracts.find((c) => c.id === id);
            return {
              client: this.data.clients.find((c) => c.id === k?.client_id)?.name,
              product: this.data.products.find((p) => p.id === k?.product_id)?.name,
            };
          };
          const before = label(task.contract_id),
            after = label(a.p_contract);
          const clientId = this.data.contracts.find(
            (c) => c.id === a.p_contract,
          )?.client_id;
          for (const t of this.data.tasks)
            if (t.id === task.id || t.parent_id === task.id) {
              t.contract_id = a.p_contract;
              t.project_id = a.p_project ?? null;
              if (
                t.team_id &&
                !this.data.clientTeams.some(
                  (ct) => ct.client_id === clientId && ct.team_id === t.team_id,
                )
              )
                t.team_id = null;
            }
          moved = {
            old_client: before.client,
            old_product: before.product,
            new_client: after.client,
            new_product: after.product,
          };
        }
        // Mirrors public.update_task: "Aplicar" the rule, or a date by hand
        // that asks the reason when moved to before the rule's minimum.
        const rule = suggestDue(this.data, {
          contract: task.contract_id,
          project: task.project_id,
          team: task.team_id,
          assignee: task.assignee_id,
          base: a.p_start || dueBase(task),
          approval: task.requires_client_approval,
        });
        const byRule = a.p_due_manual === false && !!rule;
        const due: string = byRule ? rule!.due : a.p_due;
        const oldDue = task.due_date;
        // Mirrors public.update_task (migration 20270110090000): a new due
        // date always asks why.
        if (due !== oldDue) {
          const problem = dueReasonError(a.p_due_reason);
          if (problem) throw Error(problem);
        }
        if (due !== task.due_date || byRule) {
          const tight = !byRule && !!rule?.min && due < rule.min;
          if (tight && due < task.due_date && String(a.p_due_reason ?? "").trim().length < 5)
            throw Error(
              `Este prazo fica antes do mínimo da regra (${rule!.min!.split("-").reverse().join("/")}). Explique o motivo para continuar.`,
            );
          task.due_tight_reason = tight
            ? (due < task.due_date ? String(a.p_due_reason ?? "").trim() : "") ||
              task.due_tight_reason ||
              null
            : null;
          task.due_manual = !byRule && !a.p_due_smart;
          task.due_rule_id = byRule ? rule!.rule.id : null;
          // "Usar" the MAVI's date (the demo keeps the form's date).
          task.due_smart = !!a.p_due_smart;
        }
        Object.assign(task, {
          title: a.p_title,
          description: a.p_description,
          due_date: due,
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
        event("edited", moved);
        if (due !== oldDue) this.dueChanged(task, oldDue, String(a.p_due_reason), "edit");
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
            if (review && !acts.deliver)
              throw Error(
                "Este projeto exige validação: a entrega é aprovada por quem valida",
              );
            task.internal_approved_by = demoUser;
            next = "review";
          } else if (workingStatuses.includes(target)) next = target;
          else throw Error("Status inválido");
          if (target === from && assignee === task.assignee_id)
            throw Error("Escolha outro status ou outro responsável");
          if (
            next !== from &&
            ["returned", "rejected", "correction"].includes(next) &&
            !note
          )
            throw Error(
              next === "returned"
                ? "Informe quais informações faltam"
                : next === "correction"
                  ? "Descreva a correção necessária"
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
          (next !== from &&
            ["returned", "rejected", "correction"].includes(next))
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
      case "add_comment": {
        const parent = a.p_parent
          ? this.comments.find(
              (c) => c.id === a.p_parent && c.task_id === a.p_task,
            )
          : undefined;
        if (a.p_parent && !parent)
          throw new Error("O comentário respondido não existe nesta tarefa");
        this.comments.unshift({
          id,
          company_id,
          task_id: a.p_task,
          author_id: demoUser,
          body: a.p_body,
          created_at: now,
          parent_id: parent ? (parent.parent_id ?? parent.id) : null,
        });
        this.mentionsIn(this.comments[0]);
        this.repliesTo(this.comments[0]);
        break;
      }
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
          link: "https://workspace.maso.app.br/?reset=demo-token",
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
      case "save_task_view": {
        if (a.p_default) for (const v of this.views) v.is_default = false;
        const view: TaskView = {
          id: a.p_id ?? id,
          company_id,
          user_id: demoUser,
          name: String(a.p_name).trim(),
          config: a.p_config,
          is_default: !!a.p_default,
        };
        this.views = [...this.views.filter((v) => v.id !== view.id), view].sort(
          (x, y) => x.name.localeCompare(y.name, "pt-BR"),
        );
        return view;
      }
      case "delete_task_view":
        this.views = this.views.filter((v) => v.id !== a.p_id);
        break;
      default:
        throw Error("Operação indisponível na demonstração");
    }
    // Mirrors mavi_private.pause_on_status_change: a new status pauses every
    // timer running on the task.
    if (task && statusBefore && task.status !== statusBefore)
      for (const h of this.data.hours)
        if (h.task_id === task.id && !h.ended_at) {
          h.ended_at = new Date().toISOString();
          timerComment(
            task.id,
            transitionComment(
              `Pausou o trabalho (status alterado para ${statuses[task.status].label})`,
              `Sessão de ${sessionLabel(h.started_at, h.ended_at)}`,
            ),
          );
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

/** Values as the database stores them (see mavi_private.custom_value). */
function fillDemoFields(
  fields: TaskCustomField[],
  values: Record<string, unknown>,
): TaskCustomField[] {
  return fields.map(({ value: _old, ...f }) => {
    const v = values[customKey(f)];
    const value = isEmpty(v)
      ? null
      : f.type === "number"
        ? Number(String(v).replace(",", "."))
        : f.type === "multiselect"
          ? [...new Set(v as string[])].sort()
          : f.type === "checkbox"
            ? true
            : typeof v === "string"
              ? v.trim()
              : (v as string);
    return { ...f, value };
  });
}
