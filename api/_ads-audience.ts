import { AdsError, graph, graphAll, type AdsEnv, type Fetch } from "./_ads.js";
import { deliveryOf } from "./_ads-platform.js";

/**
 * Campanhas › Plataforma › Público: what an ad set targets, read live from
 * Meta (read only) and put in the Ads Manager's words — locations, age,
 * gender, languages, the detailed targeting (interests, behaviors,
 * demographics, with its OR inside a group and AND between groups), the
 * exclusions, the custom and lookalike audiences, Advantage+ and the
 * placements — plus Meta's estimated audience size and its own summary
 * lines (targetingsentencelines, the safety net for anything not mapped).
 *
 * - audienceOf: the targeting spec → AdsetAudience (pure).
 * - platformAudience: an ad set, the ad sets of a campaign or an ad's ad
 *   set, checked to belong to the account first.
 * - reportAudiences: what a report keeps (the ad sets that delivered).
 * - audienceText: the same in plain text (the MAVI's tool).
 */

type Named = { id?: string | number; key?: string; name?: string };
type Geo = Record<string, unknown> & {
  countries?: string[];
  country_groups?: string[];
  location_types?: string[];
};
export type Targeting = Record<string, unknown> & {
  geo_locations?: Geo;
  excluded_geo_locations?: Geo;
  age_min?: number;
  age_max?: number;
  age_range?: number[];
  genders?: number[];
  locales?: number[];
  flexible_spec?: Record<string, unknown>[];
  exclusions?: Record<string, unknown>;
  custom_audiences?: Named[];
  excluded_custom_audiences?: Named[];
  publisher_platforms?: string[];
  device_platforms?: string[];
  user_os?: string[];
  user_device?: string[];
  wireless_carrier?: string[];
  targeting_optimization?: string;
  targeting_relaxation_types?: Record<string, number>;
  targeting_automation?: { advantage_audience?: number };
};

export type Place = {
  kind: string;
  name: string;
  /** "+40 km" around a city, a pin or an address. */
  radius?: string;
};
export type DetailedGroup = { category: string; items: string[] }[];
export type CustomAudience = { id: string; name: string; type?: string };
export type AdsetAudience = {
  id: string;
  name: string;
  delivery: { code: string; label: string; tone: "on" | "off" | "warn" | "bad" };
  advantage: {
    /** Público Advantage+: age, gender and interests are suggestions. */
    audience: boolean;
    /** Direcionamento detalhado Advantage (reach beyond the interests). */
    detailed: boolean;
    custom: boolean;
    lookalike: boolean;
  };
  locations: { included: Place[]; excluded: Place[]; presence: string };
  age: { min: number; max: number; plus: boolean; suggested?: { min: number; max: number } };
  gender: string;
  languages: { count: number; names: string[] };
  /** AND between the groups, OR inside each group. */
  detailed: DetailedGroup[];
  excluded_detailed: DetailedGroup;
  custom: { included: CustomAudience[]; excluded: CustomAudience[] };
  placements: {
    automatic: boolean;
    platforms: string[];
    positions: { platform: string; items: string[] }[];
    devices: string[];
    os: string[];
    wifi_only: boolean;
  };
  /** Meta's monthly estimate (null: Meta didn't give one; absent: not asked). */
  estimate?: { lower: number; upper: number } | null;
  /** Meta's own lines ("Local: Brasil"…), in Portuguese. */
  summary?: { label: string; items: string[] }[];
};

const ID = /^[0-9]{1,30}$/;
const pretty = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "";

// ------------------------------------------------------------ labels
let regionNames: Intl.DisplayNames | null | undefined;
export function countryName(code: string) {
  if (regionNames === undefined)
    try {
      regionNames = new Intl.DisplayNames(["pt-BR"], { type: "region" });
    } catch {
      regionNames = null;
    }
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
const COUNTRY_GROUPS: Record<string, string> = {
  worldwide: "Mundo todo",
  africa: "África",
  asia: "Ásia",
  europe: "Europa",
  latam: "América Latina",
  north_america: "América do Norte",
  south_america: "América do Sul",
  central_america: "América Central",
  mercosur: "Mercosul",
  eea: "Espaço Econômico Europeu",
  gcc: "Conselho de Cooperação do Golfo",
  apac: "Ásia-Pacífico",
  emea: "Europa, Oriente Médio e África",
};
/** The geo_locations keys with named items, in the Ads Manager's words. */
const GEO_KINDS: [string, string][] = [
  ["regions", "Estado"],
  ["cities", "Cidade"],
  ["subcities", "Cidade"],
  ["neighborhoods", "Bairro"],
  ["zips", "CEP"],
  ["metro_areas", "Região metropolitana"],
  ["geo_markets", "Mercado"],
  ["electoral_districts", "Distrito eleitoral"],
  ["medium_geo_areas", "Região"],
  ["large_geo_areas", "Região"],
  ["small_geo_areas", "Região"],
  ["places", "Local"],
  ["custom_locations", "Endereço"],
];
const PRESENCE: Record<string, string> = {
  "home,recent": "Pessoas que moram ou estiveram recentemente nestes locais",
  home: "Pessoas que moram nestes locais",
  recent: "Pessoas que estiveram recentemente nestes locais",
  travel_in: "Pessoas viajando para estes locais",
};
const DETAILED: Record<string, string> = {
  interests: "Interesses",
  behaviors: "Comportamentos",
  life_events: "Acontecimentos",
  family_statuses: "Família",
  industries: "Setores",
  income: "Renda",
  work_positions: "Cargos",
  work_employers: "Empregadores",
  education_schools: "Escolas",
  education_majors: "Áreas de estudo",
  education_statuses: "Escolaridade",
  relationship_statuses: "Status de relacionamento",
  college_years: "Ano de formatura",
  user_adclusters: "Categorias amplas",
  interested_in: "Interessados em",
  home_type: "Tipo de residência",
  home_ownership: "Propriedade da residência",
  home_value: "Valor da residência",
  household_composition: "Composição familiar",
  net_worth: "Patrimônio",
  moms: "Mães",
  generation: "Geração",
  politics: "Política",
};
const EDUCATION: Record<number, string> = {
  1: "Ensino médio",
  2: "Ensino superior (cursando)",
  3: "Ensino superior completo",
  4: "Ensino médio completo",
  5: "Ensino superior incompleto",
  6: "Tecnólogo",
  7: "Pós-graduação (cursando)",
  8: "Pós-graduação incompleta",
  9: "Mestrado",
  10: "Graduação profissional",
  11: "Doutorado",
  12: "Não especificado",
  13: "Ensino médio incompleto",
};
const RELATIONSHIP: Record<number, string> = {
  1: "Solteiro(a)",
  2: "Em um relacionamento",
  3: "Casado(a)",
  4: "Noivo(a)",
  6: "Não especificado",
  7: "Em união civil",
  8: "Em união estável",
  9: "Em um relacionamento aberto",
  10: "Relacionamento complicado",
  11: "Separado(a)",
  12: "Divorciado(a)",
  13: "Viúvo(a)",
};
const INTERESTED_IN: Record<number, string> = { 1: "Homens", 2: "Mulheres" };
const PUBLISHER: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  audience_network: "Audience Network",
  messenger: "Messenger",
  threads: "Threads",
  whatsapp: "WhatsApp",
};
const POSITIONS: Record<string, [string, Record<string, string>]> = {
  facebook_positions: [
    "facebook",
    {
      feed: "Feed",
      right_hand_column: "Coluna da direita",
      marketplace: "Marketplace",
      video_feeds: "Feeds de vídeo",
      story: "Stories",
      search: "Resultados da pesquisa",
      instream_video: "Vídeos in-stream",
      facebook_reels: "Reels",
      facebook_reels_overlay: "Anúncios sobrepostos no Reels",
      profile_feed: "Feed do perfil",
      notification: "Notificações",
      biz_disco_feed: "Descoberta de empresas",
    },
  ],
  instagram_positions: [
    "instagram",
    {
      stream: "Feed",
      story: "Stories",
      explore: "Explorar",
      explore_home: "Página inicial do Explorar",
      reels: "Reels",
      profile_feed: "Feed do perfil",
      ig_search: "Resultados da pesquisa",
      profile_reels: "Reels do perfil",
    },
  ],
  audience_network_positions: [
    "audience_network",
    { classic: "Nativo, banner e intersticial", rewarded_video: "Vídeos premiados" },
  ],
  messenger_positions: [
    "messenger",
    { messenger_home: "Caixa de entrada", story: "Stories", sponsored_messages: "Mensagens patrocinadas" },
  ],
  threads_positions: ["threads", { threads_stream: "Feed" }],
};
const DEVICE: Record<string, string> = { mobile: "Celular", desktop: "Computador" };
const AUDIENCE_TYPE: Record<string, string> = {
  LOOKALIKE: "Semelhante",
  WEBSITE: "Site",
  ENGAGEMENT: "Envolvimento",
  VIDEO: "Vídeo",
  CUSTOM: "Lista de clientes",
  APP: "App",
  OFFLINE_CONVERSION: "Atividade offline",
  DATA_SET: "Conjunto de dados",
  CLAIM: "Reivindicado",
  PARTNER: "Parceiro",
  MANAGED: "Gerenciado",
  BAG_OF_ACCOUNTS: "Contas",
  FOX: "Fox",
};

// ------------------------------------------------------------ the spec
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const nameOf = (v: unknown) =>
  typeof v === "string"
    ? v
    : v && typeof v === "object"
      ? String((v as Named).name ?? (v as Named).key ?? (v as Named).id ?? "")
      : String(v ?? "");

function distance(p: Record<string, unknown>) {
  const r = Number(p.radius);
  if (!Number.isFinite(r) || r <= 0) return undefined;
  return `+${r.toLocaleString("pt-BR")} ${p.distance_unit === "mile" ? "mi" : "km"}`;
}
function placesOf(geo: Geo | undefined): Place[] {
  if (!geo) return [];
  const out: Place[] = [];
  for (const g of list<string>(geo.country_groups))
    out.push({ kind: "Região", name: COUNTRY_GROUPS[g] ?? pretty(g) });
  for (const c of list<string>(geo.countries))
    out.push({ kind: "País", name: countryName(String(c)) });
  for (const [key, kind] of GEO_KINDS)
    for (const raw of list<Record<string, unknown>>(geo[key])) {
      let name =
        key === "custom_locations"
          ? String(
              raw.address_string ??
                raw.name ??
                (raw.latitude !== undefined
                  ? `${Number(raw.latitude).toFixed(4)}, ${Number(raw.longitude).toFixed(4)}`
                  : ""),
            )
          : nameOf(raw);
      if (!name) continue;
      // "São Paulo, SP, Brasil": the region and the country when Meta sends them.
      const where = [raw.region, raw.country && key !== "regions" ? countryName(String(raw.country)) : ""]
        .filter((x) => typeof x === "string" && x && !name.includes(x as string))
        .join(", ");
      if (key === "regions" && raw.country) name = `${name}, ${countryName(String(raw.country))}`;
      out.push({ kind, name: where ? `${name}, ${where}` : name, radius: distance(raw) });
    }
  return out;
}

/** One flexible_spec entry (or the exclusions): its categories and names. */
function detailedOf(spec: Record<string, unknown> | undefined): DetailedGroup {
  if (!spec) return [];
  const out: DetailedGroup = [];
  for (const [key, value] of Object.entries(spec)) {
    const items = list<unknown>(value)
      .map((v) =>
        key === "education_statuses"
          ? (EDUCATION[Number(v)] ?? String(v))
          : key === "relationship_statuses"
            ? (RELATIONSHIP[Number(v)] ?? String(v))
            : key === "interested_in"
              ? (INTERESTED_IN[Number(v)] ?? String(v))
              : nameOf(v),
      )
      .filter(Boolean);
    if (items.length) out.push({ category: DETAILED[key] ?? pretty(key), items });
  }
  return out;
}
const audiences = (v: unknown): CustomAudience[] =>
  list<Named>(v)
    .map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? a.id ?? "") }))
    .filter((a) => a.name);

/** The targeting spec of an ad set in the Ads Manager's words. */
export function audienceOf(
  t: Targeting | undefined,
): Omit<AdsetAudience, "id" | "name" | "delivery" | "estimate" | "summary"> {
  const spec: Targeting = t ?? {};
  const geo = spec.geo_locations;
  const presence = list<string>(geo?.location_types).slice().sort().join(",");
  // Old ad sets keep interests and behaviors at the top level.
  const flexible = list<Record<string, unknown>>(spec.flexible_spec);
  const loose: Record<string, unknown> = {};
  for (const key of Object.keys(DETAILED)) if (Array.isArray(spec[key])) loose[key] = spec[key];
  const detailed = [...flexible, ...(Object.keys(loose).length ? [loose] : [])]
    .map(detailedOf)
    .filter((g) => g.length);
  const genders = list<number>(spec.genders).map(Number);
  const platforms = list<string>(spec.publisher_platforms);
  const relax = spec.targeting_relaxation_types ?? {};
  const range = list<number>(spec.age_range).map(Number);
  const ageMax = Number(spec.age_max) || 65;
  return {
    advantage: {
      audience: spec.targeting_automation?.advantage_audience === 1,
      detailed: spec.targeting_optimization === "expansion_all",
      custom: relax.custom_audience === 1,
      lookalike: relax.lookalike === 1,
    },
    locations: {
      included: placesOf(geo),
      excluded: placesOf(spec.excluded_geo_locations),
      presence: PRESENCE[presence] ?? PRESENCE["home,recent"],
    },
    age: {
      min: Number(spec.age_min) || 18,
      max: ageMax,
      plus: ageMax >= 65,
      ...(range.length === 2 && range.every(Number.isFinite)
        ? { suggested: { min: range[0], max: range[1] } }
        : {}),
    },
    gender:
      genders.length === 1 && genders[0] === 1
        ? "Homens"
        : genders.length === 1 && genders[0] === 2
          ? "Mulheres"
          : "Todos os gêneros",
    languages: { count: list(spec.locales).length, names: [] },
    detailed,
    excluded_detailed: detailedOf(spec.exclusions as Record<string, unknown> | undefined),
    custom: {
      included: audiences(spec.custom_audiences),
      excluded: audiences(spec.excluded_custom_audiences),
    },
    placements: {
      automatic: !platforms.length,
      platforms: platforms.map((p) => PUBLISHER[p] ?? pretty(p)),
      positions: Object.entries(POSITIONS)
        .map(([key, [platform, names]]) => ({
          platform: PUBLISHER[platform],
          items: list<string>(spec[key]).map((p) => names[p] ?? pretty(p)),
        }))
        .filter((p) => p.items.length),
      devices: list<string>(spec.device_platforms).map((d) => DEVICE[d] ?? pretty(d)),
      os: list<string>(spec.user_os).map((o) => o.replace(/_ver_/i, " ").replace(/_/g, " ")),
      wifi_only: list<string>(spec.wireless_carrier).some((w) => /wifi/i.test(w)),
    },
  };
}

// ------------------------------------------------------------ requests
const ADSET_FIELDS =
  "id,name,account_id,effective_status,configured_status,end_time,targeting";
/** How many ad sets of a campaign get the estimate and Meta's summary. */
export const ESTIMATE_MAX = 10;
const MAX_ADSETS = 100;

type AdsetRaw = {
  id: string;
  name?: string;
  account_id?: string;
  effective_status?: string;
  configured_status?: string;
  end_time?: string;
  targeting?: Targeting;
};
const sameAccount = (a: unknown, b: string) =>
  String(a ?? "").replace(/^act_/i, "") === b;

export type PlatformAudience = {
  level: "campaign" | "adset" | "ad";
  adsets: AdsetAudience[];
  /** More ad sets than ESTIMATE_MAX: the rest come without the estimate. */
  estimated: number;
  fetched_at: string;
};

/**
 * The audience of an ad set, of each ad set of a campaign (the active
 * first) or of an ad's ad set. The object must be of the account.
 */
export async function platformAudience(
  env: AdsEnv,
  fetchImpl: Fetch,
  token: string,
  raw: Record<string, unknown>,
  now = new Date(),
): Promise<PlatformAudience> {
  const account = String(raw.account ?? "").replace(/^act_/i, "");
  if (!ID.test(account)) throw new AdsError(400, "Conta de anúncio inválida.");
  const id = String(raw.id ?? "");
  if (!ID.test(id)) throw new AdsError(400, "Item inválido.");
  const level = raw.level === "campaign" || raw.level === "ad" ? raw.level : "adset";
  const fields =
    level === "adset"
      ? ADSET_FIELDS
      : level === "ad"
        ? `account_id,adset{${ADSET_FIELDS}}`
        : `account_id,adsets.limit(${MAX_ADSETS}){${ADSET_FIELDS}}`;
  const body = await graph<
    AdsetRaw & { adset?: AdsetRaw; adsets?: { data?: AdsetRaw[] } }
  >(env, fetchImpl, token, `/${id}`, { fields });
  if (!sameAccount(body.account_id, account))
    throw new AdsError(403, "Este item não é da conta de anúncio escolhida.");
  const raws =
    level === "adset"
      ? [body]
      : level === "ad"
        ? body.adset
          ? [body.adset]
          : []
        : (body.adsets?.data ?? []);
  const sets: AdsetAudience[] = raws
    .filter((s) => s.effective_status !== "DELETED")
    .map((s) => toAudience(s, now))
    .sort(
      (a, b) =>
        Number(b.delivery.tone === "on") - Number(a.delivery.tone === "on") ||
        a.name.localeCompare(b.name, "pt-BR"),
    );

  await enrich(env, fetchImpl, token, sets);
  return {
    level,
    adsets: sets,
    estimated: Math.min(sets.length, ESTIMATE_MAX),
    fetched_at: now.toISOString(),
  };
}

/**
 * The custom audiences' kind (lookalike, site…) in one read, and the
 * estimate and Meta's summary of the first ESTIMATE_MAX ad sets (2 reads
 * each). Nothing here fails the audience: what Meta refuses is left out.
 */
async function enrich(env: AdsEnv, fetchImpl: Fetch, token: string, sets: AdsetAudience[]) {
  // The custom audiences' kind (lookalike, site…): one read for all.
  const audienceIds = [
    ...new Set(
      sets.flatMap((s) => [...s.custom.included, ...s.custom.excluded].map((a) => a.id)),
    ),
  ].filter((x) => ID.test(x));
  const kinds = new Map<string, string>();
  for (let i = 0; i < audienceIds.length; i += 50) {
    const found = await graph<Record<string, { subtype?: string }>>(env, fetchImpl, token, "/", {
      ids: audienceIds.slice(i, i + 50).join(","),
      fields: "subtype",
    }).catch(() => ({}) as Record<string, { subtype?: string }>);
    for (const [aid, a] of Object.entries(found))
      if (a?.subtype) kinds.set(aid, AUDIENCE_TYPE[a.subtype] ?? pretty(a.subtype.toLowerCase()));
  }
  for (const s of sets)
    for (const a of [...s.custom.included, ...s.custom.excluded])
      if (kinds.has(a.id)) a.type = kinds.get(a.id);

  // The estimate and Meta's summary of the first ad sets (2 reads each).
  await Promise.all(
    sets.slice(0, ESTIMATE_MAX).map(async (s) => {
      const [estimate, lines] = await Promise.all([
        graph<{
          data?: {
            estimate_ready?: boolean;
            estimate_mau_lower_bound?: number;
            estimate_mau_upper_bound?: number;
          }[];
        }>(env, fetchImpl, token, `/${s.id}/delivery_estimate`, {
          fields: "estimate_ready,estimate_mau_lower_bound,estimate_mau_upper_bound",
        }).catch(() => null),
        graph<{
          data?: { targetingsentencelines?: { content?: string; children?: string[] }[] }[];
        }>(env, fetchImpl, token, `/${s.id}/targetingsentencelines`, {
          locale: "pt_BR",
        }).catch(() => null),
      ]);
      const e = estimate?.data?.[0];
      const lower = Number(e?.estimate_mau_lower_bound);
      const upper = Number(e?.estimate_mau_upper_bound);
      s.estimate =
        e && Number.isFinite(lower) && Number.isFinite(upper) && upper > 0
          ? { lower, upper }
          : null;
      const summary = (lines?.data?.[0]?.targetingsentencelines ?? [])
        .map((l) => ({
          label: String(l.content ?? "").replace(/:\s*$/, "").trim(),
          items: list<string>(l.children).map(String).filter(Boolean),
        }))
        .filter((l) => l.label || l.items.length);
      if (summary.length) s.summary = summary;
      // The languages' names only come in Meta's summary.
      const languages = summary.find((l) => /idioma|language/i.test(l.label));
      if (languages && s.languages.count) s.languages.names = languages.items;
    }),
  );
}

/** One ad set as a card (delivery, the targeting in words). */
function toAudience(s: AdsetRaw, now: Date): AdsetAudience {
  return {
    id: s.id,
    name: s.name ?? s.id,
    delivery: deliveryOf(s.effective_status, s.configured_status, s.end_time, now),
    ...audienceOf(s.targeting),
  };
}

// ------------------------------------------------------------ reports
/**
 * What a report keeps of the audience: the ad sets that delivered in the
 * period, in the campaigns linked to the cycles (none linked: the whole
 * account), the ones that spent the most first (up to `max`), with the
 * estimate of the first ones — a photo of the day the report is made.
 */
export async function reportAudiences(
  env: AdsEnv,
  fetchImpl: Fetch,
  tokenFor: (account: string) => Promise<string>,
  links: { account_id: string; campaign_id: string }[],
  start: string,
  end: string,
  max = 30,
  now = new Date(),
): Promise<AdsetAudience[]> {
  const accounts = new Map<string, Set<string> | null>();
  for (const l of links) {
    const id = String(l.account_id).replace(/^act_/i, "");
    if (!ID.test(id) || accounts.get(id) === null) continue;
    if (!l.campaign_id) accounts.set(id, null);
    else accounts.set(id, (accounts.get(id) ?? new Set<string>()).add(l.campaign_id));
  }
  const spent: { account: string; id: string; spend: number }[] = [];
  const tokens = new Map<string, string>();
  for (const [account, campaigns] of accounts) {
    const token = await tokenFor(account);
    tokens.set(account, token);
    const rows = await graphAll<{ adset_id?: string; spend?: string }>(
      env,
      fetchImpl,
      token,
      `/act_${account}/insights`,
      {
        level: "adset",
        fields: "adset_id,spend",
        time_range: JSON.stringify({ since: start, until: end }),
        limit: "500",
        ...(campaigns?.size
          ? { filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: [...campaigns] }]) }
          : {}),
      },
    );
    for (const r of rows)
      if (r.adset_id && ID.test(r.adset_id) && Number(r.spend) > 0)
        spent.push({ account, id: r.adset_id, spend: Number(r.spend) });
  }
  const top = spent.sort((a, b) => b.spend - a.spend).slice(0, max);
  const out: AdsetAudience[] = [];
  for (const [account, token] of tokens) {
    const ids = top.filter((t) => t.account === account).map((t) => t.id);
    const sets: AdsetAudience[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const found = await graph<Record<string, AdsetRaw>>(env, fetchImpl, token, "/", {
        ids: ids.slice(i, i + 50).join(","),
        fields: ADSET_FIELDS,
      });
      for (const s of Object.values(found))
        if (s?.id && sameAccount(s.account_id, account)) sets.push(toAudience(s, now));
    }
    const order = new Map(ids.map((id, i) => [id, i]));
    sets.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    await enrich(env, fetchImpl, token, sets);
    out.push(...sets);
  }
  const rank = new Map(top.map((t, i) => [t.id, i]));
  return out.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

// ------------------------------------------------------------ text
const join = (items: string[]) => items.join(", ");
export const ageText = (a: AdsetAudience["age"]) =>
  `${a.min}–${a.plus ? "65+" : a.max}`;
export const placeText = (p: Place) =>
  `${p.name}${p.radius ? ` (${p.radius})` : ""}`;
export const estimateText = (e: { lower: number; upper: number }) =>
  `${e.lower.toLocaleString("pt-BR")} – ${e.upper.toLocaleString("pt-BR")} pessoas`;

/** An ad set's audience in plain text (the MAVI reads it). */
export function audienceText(s: AdsetAudience) {
  const out: string[] = [`Conjunto ${s.id} "${s.name}" (${s.delivery.label}):`];
  if (s.advantage.audience)
    out.push("- Público Advantage+ ligado: idade, gênero e direcionamento detalhado são sugestões; o Meta pode ir além.");
  out.push(
    `- Locais: ${s.locations.included.length ? join(s.locations.included.map(placeText)) : "—"} · ${s.locations.presence}`,
  );
  if (s.locations.excluded.length)
    out.push(`- Locais excluídos: ${join(s.locations.excluded.map(placeText))}`);
  out.push(
    `- Idade: ${ageText(s.age)}${s.age.suggested ? ` (sugestão: ${s.age.suggested.min}–${s.age.suggested.max >= 65 ? "65+" : s.age.suggested.max})` : ""} · ${s.gender}`,
  );
  if (s.languages.count)
    out.push(`- Idiomas: ${s.languages.names.length ? join(s.languages.names) : `${s.languages.count} selecionados`}`);
  if (s.custom.included.length)
    out.push(`- Públicos personalizados incluídos: ${join(s.custom.included.map((a) => `${a.name}${a.type ? ` [${a.type}]` : ""}`))}`);
  if (s.custom.excluded.length)
    out.push(`- Públicos personalizados excluídos: ${join(s.custom.excluded.map((a) => `${a.name}${a.type ? ` [${a.type}]` : ""}`))}`);
  s.detailed.forEach((g, i) =>
    out.push(
      `- ${i === 0 ? "Direcionamento detalhado — inclui pessoas com" : "E também com"} (qualquer um): ${g
        .map((c) => `${c.category}: ${join(c.items)}`)
        .join(" | ")}`,
    ),
  );
  if (!s.detailed.length) out.push("- Direcionamento detalhado: nenhum (público aberto)");
  if (s.advantage.detailed) out.push("- Direcionamento detalhado Advantage: ligado (pode ir além dos interesses)");
  if (s.excluded_detailed.length)
    out.push(`- Excluir pessoas com: ${s.excluded_detailed.map((c) => `${c.category}: ${join(c.items)}`).join(" | ")}`);
  out.push(
    `- Posicionamentos: ${
      s.placements.automatic
        ? "Advantage+ (automáticos)"
        : `${join(s.placements.platforms)}${s.placements.positions.length ? ` — ${s.placements.positions.map((p) => `${p.platform}: ${join(p.items)}`).join("; ")}` : ""}`
    }${s.placements.devices.length ? ` · dispositivos: ${join(s.placements.devices)}` : ""}${s.placements.os.length ? ` · sistemas: ${join(s.placements.os)}` : ""}${s.placements.wifi_only ? " · só Wi-Fi" : ""}`,
  );
  if (s.estimate) out.push(`- Tamanho estimado (Meta): ${estimateText(s.estimate)}`);
  return out.join("\n");
}
