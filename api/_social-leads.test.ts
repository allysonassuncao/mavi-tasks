import { describe, expect, it } from "vitest";
import {
  SYSTEM_PROMPT,
  handleSocialLeads,
  planRequest,
  siteDomains,
  socialLeadsEnv,
  type Deps,
  type ModelRequest,
} from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const contract = "00000000-0000-4000-8000-000000000025";
const planId = "00000000-0000-4000-8000-000000000099";
const env = {
  ...socialLeadsEnv({}),
  anthropicKey: "sk-test",
  supabaseUrl: "https://db.test",
  supabaseKey: "anon",
};
const context = {
  job: "job-1",
  client_name: "Agente Stravitta",
  briefing: {
    clientName: "Agente Stravitta",
    igHandle: "@orenatolive",
    fbHandle: "Criar página",
    websiteUrl: "https://agente.astravitta.com.br/",
    notes: "Não gerar promessas.",
  },
  campaign_objective: "form_nativo",
  responsible: "Lorena Amaral",
  next_month: 1,
  previous: null,
};

/** The database answering each function, and what was called. */
function fakeDb(
  answers: Record<string, (args: any) => { status?: number; body: unknown }>,
) {
  const calls: { name: string; args: any; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const name = String(url).split("/rpc/")[1];
    const args = JSON.parse(String(init.body));
    calls.push({ name, args, auth: (init.headers as any).Authorization });
    const a = answers[name]?.(args) ?? { body: null };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
function deps(
  fetchImpl: typeof fetch,
  replies: string[],
  seen: ModelRequest[] = [],
): Deps & { work: Promise<unknown>[] } {
  const work: Promise<unknown>[] = [];
  return {
    fetch: fetchImpl,
    complete: async (_env, request) => {
      seen.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error("sem resposta");
      return next;
    },
    background: (p) => work.push(p),
    work,
  };
}

describe("geração do plano", () => {
  it("abre a geração, responde na hora e grava o plano como a pessoa", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: context }),
      social_leads_write_plan: () => ({ body: { id: planId, version: 1 } }),
    });
    const seen: ModelRequest[] = [];
    const d = deps(fetchImpl, ['{"plano":"ok"}'], seen);
    const r = await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer user-token",
      env,
      d,
    );
    expect(r).toEqual({ status: 202, body: { job: "job-1" } });
    await Promise.all(d.work);
    expect(calls.map((c) => c.name)).toEqual([
      "social_leads_start_job",
      "social_leads_write_plan",
      "social_leads_finish_job",
    ]);
    expect(calls.every((c) => c.auth === "Bearer user-token")).toBe(true);
    expect(calls[1].args).toMatchObject({
      p_plan: null,
      p_content: { plano: "ok" },
      p_source: "ai",
    });
    expect(calls[2].args).toEqual({
      p_job: "job-1",
      p_plan: planId,
      p_error: null,
    });
    // O site do cliente entra; o Instagram não (pede login).
    expect(seen[0].domains).toEqual(["agente.astravitta.com.br"]);
    expect(seen[0].user).toContain('"notes": "Não gerar promessas."');
  });

  it("pede de novo uma vez quando o banco recusa a estrutura", async () => {
    let writes = 0;
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: context }),
      social_leads_write_plan: () =>
        ++writes === 1
          ? {
              status: 400,
              body: { message: "O plano precisa de exatamente 8 posts." },
            }
          : { body: { id: planId, version: 1 } },
    });
    const seen: ModelRequest[] = [];
    const d = deps(fetchImpl, ["{}", "{}"], seen);
    await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      d,
    );
    await Promise.all(d.work);
    expect(seen[1].user).toContain(
      "recusada pela validação: O plano precisa de exatamente 8 posts.",
    );
    expect(calls.at(-1)?.args).toEqual({
      p_job: "job-1",
      p_plan: planId,
      p_error: null,
    });
  });

  it("registra a falha na geração para a tela mostrar", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: context }),
      social_leads_write_plan: () => ({
        status: 400,
        body: { message: "Post 2 repetido." },
      }),
    });
    const d = deps(fetchImpl, ["{}", "não é json"]);
    await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      d,
    );
    await Promise.all(d.work);
    const finish = calls.at(-1)!;
    expect(finish.name).toBe("social_leads_finish_job");
    expect(finish.args.p_error).toMatch(/não passou na validação/);
  });

  it("sem canal e sem cores não chama a IA", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({
        body: { ...context, briefing: { clientName: "X", fbHandle: "criar" } },
      }),
    });
    const d = deps(fetchImpl, []);
    const r = await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      d,
    );
    expect(r.status).toBe(422);
    expect(d.work).toEqual([]);
    expect(calls.at(-1)?.args.p_error).toMatch(/cores da marca/);
  });

  it("explica o que falta configurar e recusa quem não entrou", async () => {
    const d = deps(fakeDb({}).fetchImpl, []);
    expect(
      (
        await handleSocialLeads(
          { action: "generate", company, contract, mode: "new" },
          "Bearer t",
          { ...env, anthropicKey: "" },
          d,
        )
      ).body,
    ).toEqual({ error: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect(
      (
        await handleSocialLeads(
          { action: "generate", company, contract, mode: "new" },
          null,
          env,
          d,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleSocialLeads(
          { action: "generate", company: "x", contract, mode: "new" },
          "Bearer t",
          env,
          d,
        )
      ).status,
    ).toBe(400);
  });

  it("repassa a recusa do banco (ex.: geração em andamento)", async () => {
    const { fetchImpl } = fakeDb({
      social_leads_start_job: () => ({
        status: 400,
        body: {
          message: "Já existe uma geração em andamento para este cliente.",
        },
      }),
    });
    const r = await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      deps(fetchImpl, []),
    );
    expect(r).toEqual({
      status: 400,
      body: { error: "Já existe uma geração em andamento para este cliente." },
    });
  });
});

describe("pedido de ajuste", () => {
  it("devolve a atualização parcial no contrato do importador", async () => {
    const { fetchImpl } = fakeDb({
      social_leads_adjust_context: () => ({
        body: {
          client_name: "Agente Stravitta",
          briefing: { clientName: "Agente Stravitta" },
          campaign_objective: "ctwa",
          plan: { label: "Mês 1", posts: [] },
        },
      }),
    });
    const seen: ModelRequest[] = [];
    const r = await handleSocialLeads(
      {
        action: "adjust",
        company,
        contract,
        plan: planId,
        instruction: "Post 6 mais leve",
      },
      "Bearer t",
      env,
      deps(
        fetchImpl,
        [
          JSON.stringify({
            resumo: "Post 6 mais leve",
            alteracoes: {
              posts: [{ numero: 6, gancho: "Leve" }],
              publico: null,
              alertas: null,
            },
          }),
        ],
        seen,
      ),
    );
    expect(r).toEqual({
      status: 200,
      body: {
        update: {
          tipo: "social-leads-atualizacao",
          cliente: "Agente Stravitta",
          plano: planId,
          resumo: "Post 6 mais leve",
          alteracoes: { posts: [{ numero: 6, gancho: "Leve" }] },
        },
      },
    });
    expect(seen[0].user).toContain("Pedido da equipe: Post 6 mais leve");
    expect(seen[0].domains).toEqual([]);
  });
});

describe("pedido para a IA", () => {
  it("leva as regras e o mês anterior com as decisões", () => {
    expect(SYSTEM_PROMPT).toMatch(/Nunca invente depoimento/);
    expect(SYSTEM_PROMPT).toMatch(/PRIMEIRO alerta é o bloqueio operacional/);
    const r = planRequest(
      {
        ...context,
        campaign_objective: "ctwa",
        next_month: 2,
        previous: {
          label: "Mês 1",
          posts: [
            {
              numero: 1,
              gancho: "G",
              status: "reprovado",
              observacao: "Mais leve",
            },
          ],
          pilares: [],
          alertas: [],
        } as any,
      },
      "new",
    );
    expect(r.user).toContain("Monte o plano do Mês 2.");
    expect(r.user).toContain('"observacao": "Mais leve"');
    expect(r.user).toContain("Conversa no WhatsApp");
  });
  it("só o domínio do site do cliente", () => {
    expect(siteDomains({ websiteUrl: "www.escola.com.br/matriculas" })).toEqual(
      ["escola.com.br"],
    );
    expect(siteDomains({ websiteUrl: "nao tem" })).toEqual([]);
  });
});
