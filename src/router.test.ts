import { describe, expect, it } from "vitest";
import {
  pagePaths,
  pageUrl,
  readParam,
  resolvePage,
  companySlug,
  safeReturnPath,
  loginDestination,
  oauthConsentReturn,
  routeParts,
  taskUrl,
  taskIdFromPath,
  settingsTab,
  SETTINGS_TABS,
  MOVED_SETTINGS_TABS,
  aiTab,
  driveLocationFromPath,
  driveUrl,
  campaignIdFromPath,
  campaignUrl,
} from "./router";

describe("shareable routes", () => {
  it("resolves every page, home alias and trailing slashes", () => {
    for (const [page, path] of Object.entries(pagePaths)) {
      expect(resolvePage(path)).toBe(page);
      expect(resolvePage(path + "/")).toBe(page);
    }
    expect(resolvePage("/")).toBe("overview");
    expect(resolvePage("/pagina-inexistente")).toBeNull();
  });
  it("Painel da MAVI em /mavi, com os endereços antigos e as abas", () => {
    expect(pageUrl("aiUsage", "make")).toBe("/agencias/make/mavi");
    expect(resolvePage("/agencias/make/consumo-ia")).toBe("aiUsage");
    expect(resolvePage("/agencias/make/ia")).toBe("aiUsage");
    expect(aiTab("provedores")).toBe("provedores");
    expect(aiTab("regras")).toBe("regras");
    // Links antigos (#ia-…) continuam abrindo a aba certa.
    expect(aiTab("ia-provedores")).toBe("provedores");
    expect(aiTab("")).toBe("consumo");
    expect(aiTab("config-pessoas")).toBe("consumo");
  });
  it("uses a readable company path and resolves scoped pages", () => {
    const company = { id: "tenant-1", name: "Make Acelerador de Vendas" };
    expect(companySlug(company, [company])).toBe("make-acelerador-de-vendas");
    expect(pageUrl("projects", companySlug(company, [company]))).toBe(
      "/agencias/make-acelerador-de-vendas/projetos",
    );
    expect(resolvePage("/agencias/make-acelerador-de-vendas/projetos")).toBe(
      "projects",
    );
    expect(
      routeParts("/agencias/make-acelerador-de-vendas/clientes").company,
    ).toBe("make-acelerador-de-vendas");
    expect(resolvePage("/login")).toBeNull();
  });
  it("distinguishes companies with equivalent names", () => {
    const companies = [
      { id: "a", name: "Agência São Paulo" },
      { id: "b", name: "Agencia Sao Paulo" },
    ];
    expect(companySlug(companies[0], companies)).toBe("agencia-sao-paulo-a");
    expect(companySlug(companies[1], companies)).toBe("agencia-sao-paulo-b");
  });
  it("sends the initial page to login and retains protected destinations", () => {
    expect(loginDestination("/")).toBe("/login");
    const requested = "/agencias/make/clientes?busca=Ana";
    const url = new URL(loginDestination(requested), "https://mavi.invalid");
    expect(url.pathname).toBe("/login");
    expect(safeReturnPath(url.searchParams.get("retorno"))).toBe(requested);
  });
  it("rejects external redirects and drops auth tokens from return URLs", () => {
    for (const bad of [
      null,
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/login",
      "/unknown",
    ]) {
      expect(safeReturnPath(bad)).toBe("/visao-geral");
    }
    expect(
      safeReturnPath(
        "/clientes?access_token=secret&busca=Ana#refresh_token=secret",
      ),
    ).toBe("/clientes?busca=Ana");
  });
  it("restores filters without accepting invalid pagination", () => {
    const params = new URLSearchParams("busca=ação&minhas=1&pagina=2");
    expect(readParam<string>(params, "busca", "")).toBe("ação");
    expect(readParam<boolean>(params, "minhas", false)).toBe(true);
    expect(readParam<number>(params, "pagina", 0)).toBe(2);
    for (const invalid of ["-1", "NaN", "1.2", "Infinity"]) {
      expect(
        readParam<number>(
          new URLSearchParams({ pagina: invalid }),
          "pagina",
          0,
        ),
      ).toBe(0);
    }
  });
});

it("abre diretamente tarefas compartilhadas e preserva o retorno após login", () => {
  const task = {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Revisão de anúncios",
  };
  const url = taskUrl(task, "make");
  expect(url).toBe(
    "/agencias/make/tarefas/00000000-0000-4000-8000-000000000001/revisao-de-anuncios",
  );
  expect(resolvePage(url)).toBe("tasks");
  expect(taskIdFromPath(url)).toBe(task.id);
  expect(safeReturnPath(url)).toBe(url);
  expect(loginDestination(url)).toContain("retorno=");
  expect(taskIdFromPath("/tarefas/invalid")).toBeNull();
});

it("abre Equipe e configurações na aba do endereço, ou em Pessoas", () => {
  for (const tab of SETTINGS_TABS) expect(settingsTab(tab)).toBe(tab);
  expect(settingsTab("")).toBe("config-pessoas");
  expect(settingsTab("qualquer-coisa")).toBe("config-pessoas");
});

it("leva Grupos do Whatsapp e Avisos de falhas para o Painel da MAVI", () => {
  expect(SETTINGS_TABS).not.toContain("config-whatsapp");
  expect(aiTab(MOVED_SETTINGS_TABS["config-whatsapp"])).toBe("whatsapp");
  expect(aiTab(MOVED_SETTINGS_TABS["config-avisos"])).toBe("avisos");
});

it("volta à tela de permissão do OAuth depois do login, e a nada mais", () => {
  expect(oauthConsentReturn("/oauth/consent?authorization_id=abc-123_X")).toBe(
    "/oauth/consent?authorization_id=abc-123_X",
  );
  for (const bad of [
    null,
    "/visao-geral",
    "/oauth/consent",
    "/oauth/consent?authorization_id=a&redirect=https://mal.com",
    "https://mal.com/oauth/consent?authorization_id=a",
    "//mal.com/oauth/consent?authorization_id=a",
    "/oauth/consent?authorization_id=a%2F..",
  ])
    expect(oauthConsentReturn(bad)).toBeNull();
});

describe("Drive: cada pasta tem o seu endereço", () => {
  const client = "11111111-1111-4111-8111-111111111111";
  const contract = "22222222-2222-4222-8222-222222222222";
  const folder = "33333333-3333-4333-8333-333333333333";
  it("ida e volta entre a pasta e a URL", () => {
    const places = [
      {},
      { client },
      { client, contract },
      { folder },
      { client, recordings: true },
      { client, whatsapp: true },
      { client, dossier: true },
      { client, brand: true },
      { client, temperature: true },
      { client, radar: true },
      { client, contract, agent: true },
    ];
    for (const at of places) {
      const url = driveUrl(at, "make");
      expect(url.startsWith("/agencias/make/drive")).toBe(true);
      expect(driveLocationFromPath(url)).toEqual(at);
      expect(resolvePage(url)).toBe("drive");
      expect(safeReturnPath(url)).toBe(url);
    }
    expect(driveUrl({ client, contract })).toBe(
      `/drive/cliente/${client}/produto/${contract}`,
    );
    expect(driveUrl({ client, recordings: true })).toBe(
      `/drive/cliente/${client}/gravacoes`,
    );
    expect(driveUrl({ client, notes: true })).toBe(
      `/drive/cliente/${client}/anotacoes`,
    );
    expect(driveLocationFromPath(`/drive/cliente/${client}/anotacoes`)).toEqual(
      { client, notes: true },
    );
    // O Agente Conversacional mora dentro do produto contratado.
    expect(driveUrl({ client, contract, agent: true })).toBe(
      `/drive/cliente/${client}/produto/${contract}/agente`,
    );
    expect(driveLocationFromPath(`/drive/cliente/${client}/agente`)).toBeNull();
    // O link de uma anotação sobrevive ao login.
    expect(safeReturnPath(`/drive?nota=${folder}`)).toBe(`/drive?nota=${folder}`);
    // A pasta leva o seu cliente e produto: a URL só precisa dela.
    expect(driveUrl({ client, contract, folder })).toBe(
      `/drive/pasta/${folder}`,
    );
  });
  it("recusa endereços que não são pastas", () => {
    for (const bad of [
      "/drive/pasta/abc",
      "/drive/cliente/abc",
      `/drive/cliente/${client}/qualquer`,
      `/drive/cliente/${client}/produto/abc`,
      `/drive/${folder}`,
      "/tarefas",
    ])
      expect(driveLocationFromPath(bad)).toBeNull();
    expect(resolvePage(`/drive/cliente/${client}/qualquer`)).toBeNull();
  });
});

describe("endereço da campanha", () => {
  const id = "0b7c2f4e-5d1a-4c3b-9e8f-1a2b3c4d5e6f";
  it("abre a campanha pelo seu próprio endereço, com ou sem agência", () => {
    expect(campaignUrl(id)).toBe(`/campanhas/${id}`);
    expect(campaignUrl(id, "make")).toBe(`/agencias/make/campanhas/${id}`);
    expect(campaignIdFromPath(`/campanhas/${id}`)).toBe(id);
    expect(campaignIdFromPath(`/agencias/make/campanhas/${id}/`)).toBe(id);
    expect(resolvePage(`/agencias/make/campanhas/${id}`)).toBe("campaigns");
    // Sobrevive ao login, com a aba aberta.
    expect(safeReturnPath(`/campanhas/${id}?aba=relatorios`)).toBe(
      `/campanhas/${id}?aba=relatorios`,
    );
  });
  it("recusa o que não é uma campanha", () => {
    for (const bad of ["/campanhas", "/campanhas/abc", `/campanhas/${id}/x`])
      expect(campaignIdFromPath(bad)).toBeNull();
    expect(resolvePage("/campanhas/abc")).toBeNull();
  });
});
