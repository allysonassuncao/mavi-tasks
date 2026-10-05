import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock("./supabase", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return {
    supabase: createClient("https://hours.test", "test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchPage },
    }),
  };
});
import { companyHoursPage, HOURS_PAGE_SIZE } from "./api";

beforeEach(() => fetchPage.mockReset());

function respond(data: unknown[], range: string) {
  fetchPage.mockResolvedValue(
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Range": range },
    }),
  );
}

function request() {
  const [url, options] = fetchPage.mock.calls[0];
  return { url: new URL(url), options, headers: new Headers(options.headers) };
}

describe("histórico de horas paginado no servidor", () => {
  it("busca só 25 registros, com contagem e títulos, além do antigo limite de 100", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `entry-${100 + i}`,
      task: { title: `Tarefa histórica ${i}` },
    }));
    respond(rows, "100-124/137");
    expect(await companyHoursPage("company-a", 4)).toEqual({
      entries: rows,
      count: 137,
    });
    const { url, headers } = request();
    expect(url.pathname).toBe("/rest/v1/time_entries");
    expect(url.searchParams.get("company_id")).toBe("eq.company-a");
    expect(url.searchParams.get("offset")).toBe("100");
    expect(url.searchParams.get("limit")).toBe(String(HOURS_PAGE_SIZE));
    expect(url.searchParams.get("order")).toBe("started_at.desc,id.desc");
    expect(url.searchParams.get("select")).toContain("task:tasks(title)");
    expect(url.searchParams.get("select")).not.toContain("*");
    expect(url.searchParams.has("user_id")).toBe(false);
    expect(headers.get("prefer")).toBe("count=exact");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("envia o filtro de pessoa na consulta paginada e conta apenas seu histórico", async () => {
    respond([{ id: "mine" }], "25-25/26");
    expect(await companyHoursPage("company-a", 1, "member-a")).toEqual({
      entries: [{ id: "mine" }],
      count: 26,
    });
    const { url } = request();
    expect(url.searchParams.get("user_id")).toBe("eq.member-a");
    expect(url.searchParams.get("offset")).toBe("25");
    expect(url.searchParams.get("company_id")).toBe("eq.company-a");
  });

  it("aceita histórico vazio", async () => {
    respond([], "*/0");
    expect(await companyHoursPage("company-a", 0)).toEqual({
      entries: [],
      count: 0,
    });
  });

  it("preserva o erro de página removida para a tela voltar ao início", async () => {
    fetchPage.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "PGRST103",
          message: "Requested range not satisfiable",
        }),
        { status: 416, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(companyHoursPage("company-a", 5)).rejects.toMatchObject({
      code: "PGRST103",
    });
  });

  it("propaga falhas para permitir uma nova tentativa", async () => {
    fetchPage.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "42501",
          message: "Acesso negado",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(companyHoursPage("company-a", 0)).rejects.toMatchObject({
      message: "Acesso negado",
    });
  });

  it("encaminha o sinal que cancela consultas ao trocar de página ou sair da tela", async () => {
    respond([], "*/0");
    const controller = new AbortController();
    await companyHoursPage("company-a", 0, undefined, controller.signal);
    expect(request().options.signal).toBe(controller.signal);
  });
});
