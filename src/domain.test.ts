import { describe, it, expect } from "vitest";
import {
  dateKey,
  isLate,
  minutes,
  duration,
  taskTimerSeconds,
  formatClock,
  durationWithSeconds,
  canApproveTask,
  canCreateTaskIn,
  teamClientIds,
  contractDetail,
  contractProductLabel,
} from "./domain";
import { demoSnapshot } from "./demo";
import type { TimeEntry } from "./types";

describe("Datas e horas operacionais", () => {
  it("calcula o dia usando o fuso da empresa", () =>
    expect(dateKey(new Date("2026-09-19T01:00:00Z"), "America/Sao_Paulo")).toBe(
      "2026-09-18",
    ));
  it("validação pendente continua atrasada após o prazo", () => {
    const t = {
      ...demoSnapshot().tasks[0],
      status: "review" as const,
      due_date: "2026-09-17",
    };
    expect(isLate(t, "2026-09-18")).toBe(true);
    expect(isLate({ ...t, status: "done" }, "2026-09-18")).toBe(false);
  });
  it("mantém cronômetro a partir do horário persistido", () =>
    expect(
      minutes(
        {
          id: "1",
          company_id: "1",
          task_id: "1",
          user_id: "1",
          started_at: "2026-09-18T12:00:00Z",
          ended_at: null,
          note: "",
          source: "timer",
        },
        Date.parse("2026-09-18T13:30:00Z"),
      ),
    ).toBe(90));
  it("apresenta horas sem perder os minutos", () =>
    expect(duration(125)).toBe("2h 05m"));

  it("calcula o tempo acumulado da tarefa e não zera o cronômetro", () => {
    const hours: TimeEntry[] = [
      {
        id: "e1",
        company_id: "c1",
        task_id: "t1",
        user_id: "u1",
        started_at: "2026-09-18T10:00:00Z",
        ended_at: "2026-09-18T10:15:30Z", // 15m 30s = 930s
        note: "",
        source: "timer",
      },
      {
        id: "e2",
        company_id: "c1",
        task_id: "t1",
        user_id: "u1",
        started_at: "2026-09-18T11:00:00Z",
        ended_at: "2026-09-18T11:05:00Z", // 5m = 300s
        note: "",
        source: "manual",
      },
      {
        id: "e3",
        company_id: "c1",
        task_id: "t2", // outra tarefa
        user_id: "u1",
        started_at: "2026-09-18T09:00:00Z",
        ended_at: "2026-09-18T09:30:00Z",
        note: "",
        source: "timer",
      },
    ];

    // Quando parado, mantém o total acumulado das entradas passadas (930s + 300s = 1230s = 20m 30s)
    const stoppedSeconds = taskTimerSeconds(hours, "t1", null);
    expect(stoppedSeconds).toBe(1230);
    expect(formatClock(stoppedSeconds)).toBe("00:20:30");

    // Quando uma nova sessão inicia, continua a partir do valor acumulado (não inicia do zero)
    const runningEntry: TimeEntry = {
      id: "e4",
      company_id: "c1",
      task_id: "t1",
      user_id: "u1",
      started_at: "2026-09-18T14:00:00Z",
      ended_at: null,
      note: "",
      source: "timer",
    };

    // 10 segundos após o início da nova sessão:
    const now10s = Date.parse("2026-09-18T14:00:10Z");
    const runningSeconds10s = taskTimerSeconds(
      hours,
      "t1",
      runningEntry,
      now10s,
    );
    expect(runningSeconds10s).toBe(1240); // 1230s acumulados + 10s atuais
    expect(formatClock(runningSeconds10s)).toBe("00:20:40");

    // Para uma tarefa nova sem histórico:
    expect(taskTimerSeconds(hours, "t3", null)).toBe(0);
    expect(formatClock(0)).toBe("00:00:00");
  });

  it("formata o relógio corretamente no padrão HH:MM:SS", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(59)).toBe("00:00:59");
    expect(formatClock(60)).toBe("00:01:00");
    expect(formatClock(3599)).toBe("00:59:59");
    expect(formatClock(3600)).toBe("01:00:00");
    expect(formatClock(3665)).toBe("01:01:05");
  });
});

describe("Produtos contratados", () => {
  it("omite o nome quando só repete cliente e produto", () => {
    expect(
      contractDetail("Social Leads · Aurora", "Social Leads", "Aurora Studio"),
    ).toBe("");
    expect(contractDetail("Make Ads", "Make Ads", "Norte")).toBe("");
    expect(contractDetail("  ", "Make Ads", "Norte")).toBe("");
  });
  it("mantém uma identificação própria", () =>
    expect(contractDetail("Unidade Centro", "Make Ads", "Norte")).toBe(
      "Unidade Centro",
    ));
  it("rotula o produto contratado sem repetir o cliente", () => {
    const data = demoSnapshot();
    const contract = data.contracts[0];
    const product = data.products.find((p) => p.id === contract.product_id)!;
    expect(contractProductLabel(data, contract.id)).toBe(product.name);
  });
});

describe("Tempo trabalhado com segundos", () => {
  it("mostra horas, minutos e segundos", () => {
    expect(durationWithSeconds(0)).toBe("0h 00m 00s");
    expect(durationWithSeconds(3909)).toBe("1h 05m 09s");
    expect(durationWithSeconds(59.9)).toBe("0h 00m 59s");
    expect(durationWithSeconds(-5)).toBe("0h 00m 00s");
  });
});

describe("Quem valida tarefas de um projeto", () => {
  const setup = (
    requires_review: boolean,
    approver: "creator" | "supervisor",
  ) => {
    const data = demoSnapshot();
    const project = { ...data.projects[0], requires_review, approver };
    data.projects = [project];
    // Marina (gestora) is only in the task's team; Lucas created the task.
    data.teamMembers = [
      {
        company_id: project.company_id,
        team_id: data.teams[0].id,
        user_id: "user-marina",
        supervisor: true,
      },
    ];
    const task = {
      ...data.tasks[0],
      project_id: project.id,
      contract_id: project.contract_id,
      team_id: data.teams[0].id,
      creator_id: "user-lucas",
    };
    return { data, task };
  };
  it("administrador valida sempre", () => {
    const { data, task } = setup(true, "creator");
    expect(canApproveTask(data, task, "user-allyson")).toBe(true);
  });
  it("criador valida; gestor não criador não", () => {
    const { data, task } = setup(true, "creator");
    expect(canApproveTask(data, task, "user-lucas")).toBe(true);
    expect(canApproveTask(data, task, "user-marina")).toBe(false);
  });
  it("supervisor da equipe valida; criador não", () => {
    const { data, task } = setup(true, "supervisor");
    expect(canApproveTask(data, task, "user-marina")).toBe(true);
    expect(canApproveTask(data, task, "user-lucas")).toBe(false);
  });
  it("gestor da equipe que não é supervisor não valida", () => {
    const { data, task } = setup(true, "supervisor");
    data.teamMembers = data.teamMembers.map((tm) => ({
      ...tm,
      supervisor: false,
    }));
    expect(canApproveTask(data, task, "user-marina")).toBe(false);
  });
  it("gestor fora da equipe da tarefa não é supervisor", () => {
    const { data, task } = setup(true, "supervisor");
    const other = { ...task, team_id: data.teams[1].id };
    expect(canApproveTask(data, other, "user-marina")).toBe(false);
  });
});

describe("Onde a pessoa pode criar tarefas", () => {
  it("administrador cria em qualquer cliente; colaborador só nos da sua equipe", () => {
    const data = demoSnapshot();
    const contract = data.contracts[0];
    data.teamMembers = [
      {
        company_id: contract.company_id,
        team_id: data.teams[0].id,
        user_id: "user-lucas",
      },
    ];
    data.clientTeams = [
      {
        company_id: contract.company_id,
        client_id: contract.client_id,
        team_id: data.teams[0].id,
      },
    ];
    expect(canCreateTaskIn(data, contract.id, "user-allyson")).toBe(true);
    expect(canCreateTaskIn(data, contract.id, "user-lucas")).toBe(true);
    expect(canCreateTaskIn(data, contract.id, "user-julia")).toBe(false);
  });
});

describe("Clientes das equipes da pessoa", () => {
  it("inclui só os clientes atendidos pelas equipes dela", () => {
    const data = demoSnapshot();
    const [aurora, norte] = data.clients;
    const company_id = aurora.company_id;
    data.teamMembers = [
      { company_id, team_id: data.teams[0].id, user_id: "user-lucas" },
    ];
    data.clientTeams = [
      { company_id, client_id: aurora.id, team_id: data.teams[0].id },
      { company_id, client_id: norte.id, team_id: data.teams[1].id },
    ];
    expect([...teamClientIds(data, "user-lucas")]).toEqual([aurora.id]);
    expect(teamClientIds(data, "user-julia").size).toBe(0);
  });
});

describe("Colaborador supervisor", () => {
  it("valida e enxerga as tarefas da equipe que supervisiona", async () => {
    const { demoSnapshot } = await import("./demo");
    const { canApproveTask, canSeeTask } = await import("./domain");
    const data = demoSnapshot();
    const member = data.members.find((m) => m.role === "member")!;
    const task = {
      ...data.tasks[0],
      creator_id: "outra-pessoa",
      assignee_id: "outra-pessoa",
      team_id: "equipe-x",
    };
    const project = data.projects.find((p) => p.id === task.project_id)!;
    project.requires_review = true;
    project.approver = "supervisor";
    expect(canSeeTask(data, task, member.user_id)).toBe(false);
    data.teamMembers.push({
      company_id: task.company_id,
      team_id: "equipe-x",
      user_id: member.user_id,
      supervisor: true,
    });
    expect(canSeeTask(data, task, member.user_id)).toBe(true);
    expect(canApproveTask(data, task, member.user_id)).toBe(true);
  });
});
