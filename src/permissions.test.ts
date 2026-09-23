import { describe, expect, it } from "vitest";
import type { Task, Member } from "./types";

describe("Controle de Acesso e Permissões", () => {
  const admin: Member = {
    company_id: "c1",
    user_id: "user-admin",
    name: "Admin User",
    email: "admin@example.com",
    role: "admin",
    active: true,
  };
  const manager: Member = {
    company_id: "c1",
    user_id: "user-manager",
    name: "Manager User",
    email: "manager@example.com",
    role: "manager",
    active: true,
  };
  const member: Member = {
    company_id: "c1",
    user_id: "user-collab",
    name: "Collab User",
    email: "collab@example.com",
    role: "member",
    active: true,
  };

  function isLeader(m?: Member | null): boolean {
    return m?.role === "admin" || m?.role === "manager";
  }

  const allNavigation = [
    { id: "overview", label: "Visão geral" },
    { id: "tasks", label: "Tarefas" },
    { id: "clients", label: "Clientes" },
    { id: "products", label: "Produtos" },
    { id: "contracts", label: "Produtos contratados" },
    { id: "projects", label: "Projetos" },
    { id: "hours", label: "Controle de horas" },
    { id: "reports", label: "Relatórios" },
  ];

  function allowedNavigation(m: Member) {
    return isLeader(m)
      ? allNavigation
      : allNavigation.filter((item) => item.id === "tasks");
  }

  it("identifica corretamente administradores e gestores como líderes", () => {
    expect(isLeader(admin)).toBe(true);
    expect(isLeader(manager)).toBe(true);
    expect(isLeader(member)).toBe(false);
    expect(isLeader(null)).toBe(false);
  });

  it("restringe o menu de navegação apenas para 'Tarefas' para colaboradores", () => {
    const navCollab = allowedNavigation(member);
    expect(navCollab).toEqual([{ id: "tasks", label: "Tarefas" }]);
  });

  it("concede todos os menus de navegação para administradores e gestores", () => {
    expect(allowedNavigation(admin)).toEqual(allNavigation);
    expect(allowedNavigation(manager)).toEqual(allNavigation);
  });

  describe("Visibilidade de Tarefas", () => {
    const baseTask: Omit<Task, "id" | "title" | "assignee_id" | "creator_id"> = {
      company_id: "c1",
      contract_id: "k1",
      project_id: null,
      team_id: null,
      parent_id: null,
      status: "open",
      priority: "normal",
      due_date: "2026-09-30",
      original_due_date: "2026-09-30",
      start_date: null,
      description: "",
      estimated_minutes: 60,
      requires_client_approval: false,
      internal_approved_by: null,
      client_approved_by: null,
      client_approval_note: null,
      revision: 0,
      version: 1,
      archived: false,
      delivered_at: null,
      created_at: "2026-09-01T00:00:00Z",
    };

    const tasks: Task[] = [
      {
        ...baseTask,
        id: "t1",
        title: "Tarefa do colaborador",
        assignee_id: "user-collab",
        creator_id: "user-admin",
      },
      {
        ...baseTask,
        id: "t2",
        title: "Tarefa criada pelo colaborador para outro",
        assignee_id: "user-other",
        creator_id: "user-collab",
        status: "progress",
        priority: "high",
        estimated_minutes: 120,
      },
      {
        ...baseTask,
        id: "t3",
        title: "Tarefa de terceiros",
        assignee_id: "user-other",
        creator_id: "user-admin",
        status: "review",
        priority: "urgent",
        estimated_minutes: 180,
        requires_client_approval: true,
      },
    ];

    function filterVisibleTasks(all: Task[], u: Member): Task[] {
      if (isLeader(u)) return all;
      return all.filter(
        (t) => t.assignee_id === u.user_id || t.creator_id === u.user_id,
      );
    }

    it("permite que administradores e gestores vejam todas as tarefas", () => {
      expect(filterVisibleTasks(tasks, admin).length).toBe(3);
      expect(filterVisibleTasks(tasks, manager).length).toBe(3);
    });

    it("restringe colaborador a ver apenas tarefas para ele ou criadas por ele", () => {
      const visible = filterVisibleTasks(tasks, member);
      expect(visible.map((t) => t.id)).toEqual(["t1", "t2"]);
      expect(visible.some((t) => t.id === "t3")).toBe(false);
    });
  });

  describe("Botões e Transições de Status", () => {
    function canApproveTask(t: Task, u: Member): boolean {
      return isLeader(u);
    }

    function canWorkTask(t: Task, u: Member): boolean {
      return (
        isLeader(u) ||
        t.creator_id === u.user_id ||
        t.assignee_id === u.user_id
      );
    }

    const reviewTask: Task = {
      id: "t-review",
      company_id: "c1",
      contract_id: "k1",
      project_id: null,
      team_id: null,
      parent_id: null,
      title: "Tarefa para aprovação",
      assignee_id: "user-collab",
      creator_id: "user-collab",
      status: "review",
      priority: "normal",
      due_date: "2026-09-30",
      original_due_date: "2026-09-30",
      start_date: null,
      description: "",
      estimated_minutes: 60,
      requires_client_approval: false,
      internal_approved_by: null,
      client_approved_by: null,
      client_approval_note: null,
      revision: 0,
      version: 1,
      archived: false,
      delivered_at: null,
      created_at: "2026-09-01T00:00:00Z",
    };

    it("administrador e gestor podem aprovar tarefas em revisão", () => {
      expect(canApproveTask(reviewTask, admin)).toBe(true);
      expect(canApproveTask(reviewTask, manager)).toBe(true);
    });

    it("colaborador não possui acesso a botões de aprovação de tarefa", () => {
      expect(canApproveTask(reviewTask, member)).toBe(false);
    });

    it("colaborador pode trabalhar em sua própria tarefa", () => {
      expect(canWorkTask(reviewTask, member)).toBe(true);
    });

    it("colaborador não pode trabalhar na tarefa de outro colaborador se não foi o criador", () => {
      const otherTask: Task = {
        ...reviewTask,
        creator_id: "user-admin",
        assignee_id: "user-other",
      };
      expect(canWorkTask(otherTask, member)).toBe(false);
    });
  });
});
