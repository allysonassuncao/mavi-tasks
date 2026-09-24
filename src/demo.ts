import {
  type Snapshot,
  type Task,
  type Status,
  type ProjectApprover,
} from "./types";
import { dateKey } from "./domain";
export const demoUser = "user-allyson";
const company_id = "demo-agency";
function day(offset: number) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return dateKey(d);
}
export function demoSnapshot(): Snapshot {
  const members = [
    {
      user_id: demoUser,
      name: "Allyson Assunção",
      role: "admin" as const,
      email: "allyson@mavi.app.br",
    },
    {
      user_id: "user-marina",
      name: "Marina Costa",
      role: "manager" as const,
      email: "marina@mavi.app.br",
    },
    {
      user_id: "user-lucas",
      name: "Lucas Oliveira",
      role: "member" as const,
      email: "lucas@mavi.app.br",
    },
    {
      user_id: "user-julia",
      name: "Júlia Santos",
      role: "member" as const,
      email: "julia@mavi.app.br",
    },
  ].map((m) => ({ ...m, company_id, active: true }));
  const clients = [
    {
      id: "cl-1",
      name: "Aurora Studio",
      email: "contato@aurora.example",
      color: "#a18bc8",
    },
    {
      id: "cl-2",
      name: "Norte Coffee",
      email: "ola@norte.example",
      color: "#b28a68",
    },
    {
      id: "cl-3",
      name: "Vértice Saúde",
      email: "contato@vertice.example",
      color: "#6f9c91",
    },
    {
      id: "cl-4",
      name: "Forma Living",
      email: "ola@forma.example",
      color: "#cb9c65",
    },
  ]
    .map((c) => ({ ...c, company_id, archived: false }))
    // A former client, to show the "Arquivados" filter.
    .concat({
      id: "cl-5",
      name: "Brisa Turismo",
      email: "",
      color: "#7fa3c4",
      company_id,
      archived: true,
    });
  const products = [
    { id: "pd-1", name: "Make Ads", color: "#719edc" },
    { id: "pd-2", name: "Make CRM", color: "#d09b61" },
    { id: "pd-3", name: "Social Leads", color: "#aa87d2" },
  ].map((p) => ({ ...p, company_id }));
  const contracts = [
    {
      id: "ct-1",
      client_id: "cl-1",
      product_id: "pd-3",
      name: "Social Leads · Aurora",
    },
    {
      id: "ct-2",
      client_id: "cl-2",
      product_id: "pd-1",
      name: "Make Ads · Norte",
    },
    {
      id: "ct-3",
      client_id: "cl-3",
      product_id: "pd-2",
      name: "Make CRM · Vértice",
    },
    {
      id: "ct-4",
      client_id: "cl-4",
      product_id: "pd-3",
      name: "Social Leads · Forma",
    },
    {
      id: "ct-5",
      client_id: "cl-1",
      product_id: "pd-1",
      name: "Make Ads · Aurora",
    },
  ]
    .map((c) => ({ ...c, company_id, archived: false }))
    .concat({
      id: "ct-6",
      client_id: "cl-5",
      product_id: "pd-1",
      name: "Make Ads · Brisa",
      company_id,
      archived: true,
    });
  const projects = [
    {
      id: "pr-1",
      contract_id: "ct-1",
      name: "Presença que conecta",
      due_date: day(10),
    },
    {
      id: "pr-2",
      contract_id: "ct-2",
      name: "Campanha de primavera",
      due_date: day(7),
    },
    {
      id: "pr-3",
      contract_id: "ct-3",
      name: "Implantação comercial",
      due_date: day(20),
      requires_review: false,
    },
    {
      id: "pr-4",
      contract_id: "ct-4",
      name: "Coleção novos espaços",
      due_date: day(14),
      approver: "supervisor" as const,
    },
  ].map((p) => ({
    requires_review: true,
    approver: "creator" as ProjectApprover,
    ...p,
    company_id,
    archived: false,
  }));
  const rows: [
    string,
    string,
    string | null,
    Status,
    number,
    string,
    Task["priority"],
    number,
  ][] = [
    [
      "Planejar conteúdo de outubro",
      "ct-1",
      "pr-1",
      "progress",
      0,
      "user-marina",
      "high",
      180,
    ],
    [
      "Revisar criativos da campanha",
      "ct-2",
      "pr-2",
      "review",
      0,
      "user-julia",
      "high",
      120,
    ],
    [
      "Configurar etapas do funil",
      "ct-3",
      "pr-3",
      "progress",
      2,
      "user-lucas",
      "normal",
      240,
    ],
    [
      "Ajustar copy dos anúncios",
      "ct-2",
      null,
      "returned",
      -1,
      "user-marina",
      "urgent",
      60,
    ],
    [
      "Criar carrossel de lançamento",
      "ct-4",
      "pr-4",
      "correction",
      3,
      "user-julia",
      "normal",
      180,
    ],
    [
      "Validar briefing de posicionamento",
      "ct-1",
      "pr-1",
      "done",
      -2,
      demoUser,
      "normal",
      90,
    ],
    [
      "Revisar formulário de captação",
      "ct-3",
      null,
      "progress",
      1,
      "user-lucas",
      "high",
      60,
    ],
    [
      "Preparar relatório de resultados",
      "ct-5",
      null,
      "progress",
      4,
      demoUser,
      "normal",
      120,
    ],
    [
      "Atualizar identidade dos destaques",
      "ct-4",
      "pr-4",
      "progress",
      -2,
      "user-julia",
      "high",
      150,
    ],
    [
      "Publicar campanha institucional",
      "ct-2",
      "pr-2",
      "done",
      -3,
      "user-marina",
      "normal",
      90,
    ],
    [
      "Organizar referências visuais",
      "ct-1",
      "pr-1",
      "progress",
      5,
      demoUser,
      "low",
      60,
    ],
    [
      "Revisar segmentação de público",
      "ct-5",
      null,
      "review",
      1,
      demoUser,
      "normal",
      120,
    ],
  ];
  const tasks = rows.map((r, i): Task => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    company_id,
    contract_id: r[1],
    project_id: r[2],
    team_id: i % 2 ? "team-2" : "team-1",
    parent_id: null,
    title: r[0],
    description:
      "Alinhar a entrega com o briefing e as referências do cliente. Registrar os pontos de atenção nos comentários antes de enviar para validação.",
    status: r[3],
    priority: r[6],
    creator_id: demoUser,
    assignee_id: r[5],
    due_date: day(r[4]),
    original_due_date: day(r[4]),
    estimated_minutes: r[7],
    requires_client_approval: i === 1,
    internal_approved_by: r[3] === "done" ? demoUser : null,
    client_approved_by: null,
    client_approval_note: null,
    delivered_at: r[3] === "done" ? day(r[4]) + "T15:00:00Z" : null,
    revision: 1,
    version: 1,
    archived: false,
    created_at: day(-10) + "T12:00:00Z",
  }));
  const teams = [
    { id: "team-1", name: "Estratégia & Performance", company_id },
    { id: "team-2", name: "Criação & Conteúdo", company_id },
    { id: "team-3", name: "P&D", company_id },
  ];
  return {
    companies: [
      { id: company_id, name: "Make Agency", timezone: "America/Sao_Paulo" },
    ],
    members,
    clients,
    products,
    contracts,
    projects,
    teams,
    tasks,
    teamMembers: teams.flatMap((t) =>
      members.map((m) => ({
        company_id,
        team_id: t.id,
        user_id: m.user_id,
        supervisor: m.role === "manager",
      })),
    ),
    clientTeams: clients.flatMap((c) =>
      teams.map((t) => ({ company_id, client_id: c.id, team_id: t.id })),
    ),
    // Suggestions go to P&D, in Aurora's contract.
    suggestionSettings: [
      { company_id, team_id: "team-3", contract_id: "ct-1", project_id: null },
    ],
    // Shows the template builder and the extra fields in the demo.
    taskTemplates: [
      {
        id: "tpl-ads",
        company_id,
        name: "Criativos de Make Ads",
        product_id: "pd-1",
        team_id: null,
        active: true,
        fields: [
          {
            id: "briefing",
            label: "Link do briefing",
            type: "url" as const,
            required: true,
            help: "Documento com objetivo, público e referências.",
          },
          {
            id: "formato",
            label: "Formato",
            type: "select" as const,
            required: true,
            options: ["Feed", "Stories", "Reels", "Carrossel"],
          },
          {
            id: "pecas",
            label: "Quantidade de peças",
            type: "number" as const,
            required: false,
          },
        ],
      },
      {
        id: "tpl-criacao",
        company_id,
        name: "Padrão Criação & Conteúdo",
        product_id: null,
        team_id: "team-2",
        active: true,
        fields: [
          {
            id: "redes",
            label: "Redes sociais",
            type: "multiselect" as const,
            required: false,
            options: ["Instagram", "TikTok", "LinkedIn", "YouTube"],
          },
          {
            id: "aprovacao",
            label: "Cliente já aprovou o roteiro",
            type: "checkbox" as const,
            required: false,
          },
        ],
      },
    ],
    hours: tasks.slice(0, 6).map((t, i) => ({
      id: `time-${i}`,
      company_id,
      task_id: t.id,
      user_id: t.assignee_id,
      started_at: day(-i) + "T12:00:00Z",
      ended_at: day(-i) + `T${String(13 + (i % 2)).padStart(2, "0")}:00:00Z`,
      note: "Execução da entrega",
      source: "manual",
    })),
  };
}
