import { describe, expect, it, vi } from "vitest";
import type { AdsEnv } from "./_ads";
import { audienceOf, audienceText, platformAudience, reportAudiences } from "./_ads-audience";

const env = {
  meta: { appId: "app-1", appSecret: "app-secret", version: "v23.0" },
} as unknown as AdsEnv;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Call = { url: URL };
function network(routes: [RegExp, (call: Call) => Response][]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    const call = { url: new URL(url) };
    calls.push(call);
    const route = routes.find(([re]) => re.test(url));
    if (!route) throw Error(`Rota inesperada: ${url}`);
    return route[1](call);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

const TARGETING = {
  geo_locations: {
    countries: ["BR"],
    cities: [{ key: "1", name: "Campinas", region: "São Paulo", country: "BR", radius: 17, distance_unit: "kilometer" }],
    regions: [{ key: "460", name: "Minas Gerais", country: "BR" }],
    location_types: ["recent", "home"],
  },
  excluded_geo_locations: { zips: [{ key: "BR:01310000", name: "01310-000" }] },
  age_min: 25,
  age_max: 54,
  genders: [2],
  locales: [16],
  flexible_spec: [
    {
      interests: [{ id: "6003", name: "Empreendedorismo" }, { id: "6004", name: "Marketing digital" }],
      behaviors: [{ id: "6002", name: "Administradores de páginas" }],
    },
    { education_statuses: [3, 9], work_positions: [{ id: "1", name: "Proprietário" }] },
  ],
  exclusions: { interests: [{ id: "7", name: "Concursos públicos" }] },
  custom_audiences: [{ id: "238001", name: "Semelhante (BR, 1%) – Clientes" }],
  excluded_custom_audiences: [{ id: "238002", name: "Leads 30 dias" }],
  publisher_platforms: ["facebook", "instagram"],
  facebook_positions: ["feed", "story"],
  instagram_positions: ["stream", "reels"],
  device_platforms: ["mobile"],
  targeting_optimization: "expansion_all",
};

describe("o público do conjunto nas palavras do Gerenciador", () => {
  it("locais, idade, gênero, direcionamento detalhado, exclusões e posicionamentos", () => {
    const a = audienceOf(TARGETING);
    expect(a.locations.included).toEqual([
      { kind: "País", name: "Brasil", radius: undefined },
      { kind: "Estado", name: "Minas Gerais, Brasil", radius: undefined },
      { kind: "Cidade", name: "Campinas, São Paulo, Brasil", radius: "+17 km" },
    ]);
    expect(a.locations.excluded[0]).toMatchObject({ kind: "CEP", name: "01310-000" });
    expect(a.locations.presence).toBe("Pessoas que moram ou estiveram recentemente nestes locais");
    expect(a.age).toEqual({ min: 25, max: 54, plus: false });
    expect(a.gender).toBe("Mulheres");
    expect(a.languages.count).toBe(1);
    // OR inside a group, AND between the groups.
    expect(a.detailed).toEqual([
      [
        { category: "Interesses", items: ["Empreendedorismo", "Marketing digital"] },
        { category: "Comportamentos", items: ["Administradores de páginas"] },
      ],
      [
        { category: "Escolaridade", items: ["Ensino superior completo", "Mestrado"] },
        { category: "Cargos", items: ["Proprietário"] },
      ],
    ]);
    expect(a.excluded_detailed).toEqual([{ category: "Interesses", items: ["Concursos públicos"] }]);
    expect(a.custom.included[0].name).toContain("Semelhante");
    expect(a.advantage).toEqual({ audience: false, detailed: true, custom: false, lookalike: false });
    expect(a.placements).toMatchObject({
      automatic: false,
      platforms: ["Facebook", "Instagram"],
      positions: [
        { platform: "Facebook", items: ["Feed", "Stories"] },
        { platform: "Instagram", items: ["Feed", "Reels"] },
      ],
      devices: ["Celular"],
    });
  });

  it("público aberto com Advantage+: sugestões, 65+, todos e posicionamentos automáticos", () => {
    const a = audienceOf({
      geo_locations: { countries: ["BR"] },
      age_min: 18,
      age_max: 65,
      age_range: [25, 45],
      targeting_automation: { advantage_audience: 1 },
      // Old ad sets: interests at the top level.
      interests: [{ id: "1", name: "Imóveis" }],
    });
    expect(a.advantage.audience).toBe(true);
    expect(a.age).toEqual({ min: 18, max: 65, plus: true, suggested: { min: 25, max: 45 } });
    expect(a.gender).toBe("Todos os gêneros");
    expect(a.detailed).toEqual([[{ category: "Interesses", items: ["Imóveis"] }]]);
    expect(a.placements.automatic).toBe(true);
    expect(audienceText({ id: "1", name: "Aberto", delivery: { code: "ACTIVE", label: "Ativo", tone: "on" }, ...a })).toContain(
      "Público Advantage+ ligado",
    );
  });
});

describe("a leitura do público no Meta", () => {
  it("os conjuntos da campanha (ativos primeiro), o tipo dos públicos, a estimativa e o resumo do Meta", async () => {
    const { fetch, calls } = network([
      [
        /\/11\?/,
        () =>
          json({
            account_id: "123",
            adsets: {
              data: [
                { id: "22", name: "B pausado", effective_status: "PAUSED", targeting: { geo_locations: { countries: ["BR"] } } },
                { id: "21", name: "A ativo", effective_status: "ACTIVE", targeting: TARGETING },
                { id: "23", name: "Excluído", effective_status: "DELETED" },
              ],
            },
          }),
      ],
      [/graph\.facebook\.com\/v23\.0\/\?/, () => json({ "238001": { subtype: "LOOKALIKE" }, "238002": { subtype: "WEBSITE" } })],
      [
        /\/21\/delivery_estimate/,
        () => json({ data: [{ estimate_ready: true, estimate_mau_lower_bound: 380000, estimate_mau_upper_bound: 450000 }] }),
      ],
      [/\/22\/delivery_estimate/, () => json({ error: { message: "sem estimativa" } }, 400)],
      [
        /\/21\/targetingsentencelines/,
        () =>
          json({
            data: [
              {
                targetingsentencelines: [
                  { content: "Local:", children: ["Brasil"] },
                  { content: "Idioma:", children: ["Português (Brasil)"] },
                ],
              },
            ],
          }),
      ],
      [/\/22\/targetingsentencelines/, () => json({ data: [] })],
    ]);
    const r = await platformAudience(env, fetch, "token", { account: "act_123", level: "campaign", id: "11" });
    expect(r.adsets.map((s) => s.name)).toEqual(["A ativo", "B pausado"]);
    const [a, b] = r.adsets;
    expect(a.estimate).toEqual({ lower: 380000, upper: 450000 });
    expect(b.estimate).toBeNull();
    expect(a.custom.included[0].type).toBe("Semelhante");
    expect(a.custom.excluded[0].type).toBe("Site");
    expect(a.languages.names).toEqual(["Português (Brasil)"]);
    expect(a.summary?.[0]).toEqual({ label: "Local", items: ["Brasil"] });
    expect(r.estimated).toBe(2);
    // One read with the nested ad sets; Meta's lines in Portuguese.
    const first = calls[0].url;
    expect(first.searchParams.get("fields")).toContain("adsets.limit(100){");
    const lines = calls.find((c) => c.url.pathname.endsWith("/21/targetingsentencelines"))!;
    expect(lines.url.searchParams.get("locale")).toBe("pt_BR");
  });

  it("recusa um item de outra conta", async () => {
    const other = network([[/\/99\?/, () => json({ account_id: "999", id: "99" })]]);
    await expect(
      platformAudience(env, other.fetch, "token", { account: "123", level: "adset", id: "99" }),
    ).rejects.toThrow("não é da conta");
  });

  it("o anúncio mostra o público do conjunto dele", async () => {
    const { fetch } = network([
      [/\/77\?/, () => json({ account_id: "act_123", adset: { id: "55", name: "Conjunto X", effective_status: "ACTIVE", targeting: { geo_locations: { countries: ["PT"] } } } })],
      [/delivery_estimate|targetingsentencelines/, () => json({ data: [] })],
    ]);
    const r = await platformAudience(env, fetch, "token", { account: "123", level: "ad", id: "77" });
    expect(r.adsets).toHaveLength(1);
    expect(r.adsets[0]).toMatchObject({ id: "55", name: "Conjunto X" });
    expect(r.adsets[0].locations.included[0].name).toBe("Portugal");
  });
});

describe("o que o relatório guarda do público", () => {
  it("os conjuntos que gastaram no período, nas campanhas vinculadas, do que mais gastou ao que menos", async () => {
    const { fetch, calls } = network([
      [
        /\/act_123\/insights/,
        () =>
          json({
            data: [
              { adset_id: "31", spend: "10" },
              { adset_id: "32", spend: "90" },
              { adset_id: "33", spend: "0" },
            ],
          }),
      ],
      [
        /graph\.facebook\.com\/v23\.0\/\?ids=31%2C32|graph\.facebook\.com\/v23\.0\/\?ids=32%2C31/,
        () =>
          json({
            "31": { id: "31", name: "Pequeno", account_id: "123", effective_status: "ACTIVE", targeting: { geo_locations: { countries: ["BR"] } } },
            "32": { id: "32", name: "Grande", account_id: "123", effective_status: "PAUSED", targeting: { genders: [1] } },
          }),
      ],
      [/delivery_estimate|targetingsentencelines/, () => json({ data: [] })],
    ]);
    const tokenFor = vi.fn(async () => "token");
    const list = await reportAudiences(
      env,
      fetch,
      tokenFor,
      [{ account_id: "act_123", campaign_id: "c9" }],
      "2026-09-01",
      "2026-09-30",
    );
    expect(list.map((a) => a.name)).toEqual(["Grande", "Pequeno"]);
    expect(list[0].gender).toBe("Homens");
    const insights = calls.find((c) => c.url.pathname.endsWith("/insights"))!;
    expect(insights.url.searchParams.get("filtering")).toContain("c9");
    expect(insights.url.searchParams.get("time_range")).toContain("2026-09-30");
    expect(tokenFor).toHaveBeenCalledWith("123");
  });
});
