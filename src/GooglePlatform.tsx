import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  ChevronRight,
  Columns3,
  Download,
  ExternalLink,
  Link2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { Modal } from "./components";
import { PanelChart } from "./DashboardCharts";
import type { Display, PanelSpec } from "./dashboards";
import type { AdCycle } from "./campaigns";
import { DATE_PRESETS, cached, formatValue, presetRange, type DatePreset } from "./campaign-platform";
import {
  AUCTION_COLUMNS,
  CRM_VIEWS,
  DETAILABLE,
  G_PRESETS,
  MENU,
  METRIC_COLUMNS,
  SEGMENTABLE,
  SEGMENTS,
  TEXT_COLUMNS,
  metricColumn,
  nameHeading,
  rowNoun,
  viewLabel,
  withMetrics,
  withToggle,
  type GColumn,
  type GPreset,
  type GoogleDetail,
  type GoogleList,
  type GooglePlatformBackend,
  type GoogleRow,
  type GoogleSegment,
  type GoogleView,
} from "./google-platform";
import {
  crmPipelinePath,
  crmUnmatched,
  isCrmColumn,
  withCrm,
  type CrmKey,
  type CrmLevel,
  type PlatformCrm,
} from "./platform-crm";
import { CrmLeadsLink, CrmNotice, CrmUnmatched, useCrmUtm } from "./PlatformCrm";
import "./campaign-platform.css";
import "./google-platform.css";

/**
 * Campanhas › Plataforma (Google Ads): the client's Google Ads account as
 * the Google Ads interface shows it (read only): the left menu with every
 * view, the campaign and ad group being looked at (drilling down by the
 * name), columns, segments, the period, the ads' previews and each row's
 * charts. The campaigns linked to this MAVI campaign are marked.
 */

type Prefs = { view: GoogleView; preset: GPreset; custom: string[]; period: DatePreset; since: string; until: string };
const PREFS_KEY = "mavi:campanhas:plataforma-google";
function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // A preference only.
  }
}
type Sort = { column: string; desc: boolean };
type Picked = { id: string; name: string } | null;

export function GooglePlatform({
  company,
  cycles,
  current,
  backend,
  today,
  crm = null,
}: {
  company: string;
  cycles: AdCycle[];
  current: AdCycle | null;
  backend: GooglePlatformBackend;
  today: string;
  /** The client's MakeCRM (null: the campaign has no client). */
  crm?: PlatformCrm | null;
}) {
  // The accounts of the campaign's links (the current cycle's first), with
  // the MCC they're reached through.
  const accounts = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; manager: string }>();
    for (const y of [current, ...[...cycles].reverse()])
      for (const l of y?.links ?? [])
        if (!seen.has(l.account_id))
          seen.set(l.account_id, { id: l.account_id, name: l.account_name || l.account_id, manager: l.manager_id ?? "" });
    return [...seen.values()];
  }, [cycles, current]);
  const linked = useMemo(
    () => ({
      now: new Set((current?.links ?? []).map((l) => l.campaign_id)),
      all: new Set(cycles.flatMap((y) => y.links.map((l) => l.campaign_id))),
    }),
    [cycles, current],
  );
  const saved = useMemo(loadPrefs, []);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const [view, setView] = useState<GoogleView>(saved.view ?? "campaigns");
  const [preset, setPreset] = useState<GPreset>(saved.preset ?? "desempenho");
  const [custom, setCustom] = useState<string[]>(saved.custom?.length ? saved.custom : G_PRESETS[0].columns);
  const [period, setPeriod] = useState<DatePreset>(
    saved.period && saved.period !== "maximum" ? saved.period : "last_30d",
  );
  const [customRange, setCustomRange] = useState({
    since: saved.since ?? presetRange("last_30d", today)!.since,
    until: saved.until ?? presetRange("last_30d", today)!.until,
  });
  const [campaign, setCampaign] = useState<Picked>(null);
  const [adGroup, setAdGroup] = useState<Picked>(null);
  const [segment, setSegment] = useState<GoogleSegment | "">("");
  const [geo, setGeo] = useState<"city" | "region" | "country">("city");
  const [search, setSearch] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [sort, setSort] = useState<Sort>({ column: "cost", desc: true });
  const [rawList, setList] = useState<GoogleList | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [fresh, setFresh] = useState(false);
  const [detail, setDetail] = useState<GoogleRow | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    savePrefs({ view, preset, custom, period, since: customRange.since, until: customRange.until });
  }, [view, preset, custom, period, customRange]);
  const range =
    period === "custom"
      ? customRange
      : (presetRange(period, today, current) ?? presetRange("last_30d", today)!);
  const query = {
    account: account?.id ?? "",
    manager: account?.manager ?? "",
    view,
    since: range.since,
    until: range.until,
    campaigns: campaign ? [campaign.id] : [],
    ad_groups: adGroup ? [adGroup.id] : [],
    ...(segment && SEGMENTABLE.includes(view) ? { segment } : {}),
    ...(view === "locations" ? { geo } : {}),
    removed,
  };
  const key = JSON.stringify([company, query]);
  useEffect(() => {
    if (!query.account) return;
    let live = true;
    setLoading(true);
    setError(null);
    cached(key, () => backend.list(company, query), fresh)
      .then((l) => live && setList(l))
      .catch((e) => {
        if (!live) return;
        setError({ message: (e as Error).message, code: (e as { code?: string }).code });
        setList(null);
      })
      .finally(() => {
        if (live) {
          setLoading(false);
          setFresh(false);
        }
      });
    return () => {
      live = false;
    };
    // The key holds the whole query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh, backend]);

  const metricIds = view === "auction" ? AUCTION_COLUMNS : preset === "personalizado" ? custom : (G_PRESETS.find((p) => p.id === preset)?.columns ?? G_PRESETS[0].columns);
  const columns: GColumn[] = [
    ...TEXT_COLUMNS[view],
    ...(withMetrics(view)
      ? metricIds
          .map((id) => metricColumn.get(id))
          .filter((c): c is GColumn => !!c && (!c.views || c.views.includes(view)))
      : []),
  ];

  // MakeCRM: its deals per UTM, read only while a CRM column is on screen.
  const crmWanted = columns.some((c) => isCrmColumn(c.id));
  const crmState = useCrmUtm(crm, crmWanted, range.since, range.until, refresh);
  const list = useMemo(() => {
    const at = rawList ? crmLevel(rawList.view) : null;
    if (!rawList || !at || !crmState.index) return rawList;
    const merged = withCrm(rawList.rows, crmState.index, at, (r) => crmKey(rawList.view, r));
    return {
      ...rawList,
      rows: merged.rows,
      totals: rawList.totals ? { ...rawList.totals, ...merged.totals } : null,
    };
  }, [rawList, crmState.index]);
  const unmatched = useMemo(() => {
    const at = rawList ? crmLevel(rawList.view) : null;
    if (!rawList || !at || !crmState.index || !rawList.rows.length) return [];
    const keys = rawList.rows.map((r) => crmKey(rawList.view, r)!);
    return crmUnmatched(
      crmState.index,
      at,
      keys,
      at === "campaign" ? {} : { campaigns: new Set(keys.map((k) => k.campaign)) },
    );
  }, [rawList, crmState.index]);
  const crmOpen = crm?.linked
    ? (r: GoogleRow) => {
        const k = crmKey(view, r);
        if (k) crm.open(crmPipelinePath(k, range.since, range.until));
      }
    : undefined;
  const currency = list?.account.currency ?? "BRL";
  const valueOf = useCallback(
    (c: GColumn, r: GoogleRow) => (c.text ? c.text(r) : r.metrics ? (c.value?.(r.metrics) ?? null) : null),
    [],
  );
  const rows = useMemo(() => {
    if (!list || list.view !== view) return [];
    const q = search.trim().toLocaleLowerCase("pt-BR");
    const filtered = list.rows.filter(
      (r) =>
        (!q || `${r.name} ${r.sub ?? ""}`.toLocaleLowerCase("pt-BR").includes(q)) &&
        (!onlyEnabled || r.enabled !== false),
    );
    const col = columns.find((c) => c.id === sort.column);
    return [...filtered].sort((a, b) => {
      const va = col ? valueOf(col, a) : a.name;
      const vb = col ? valueOf(col, b) : b.name;
      const cmp =
        typeof va === "string" || typeof vb === "string"
          ? String(va ?? "").localeCompare(String(vb ?? ""), "pt-BR")
          : (va ?? -Infinity) - (vb ?? -Infinity);
      return sort.desc ? -cmp : cmp;
    });
    // Columns change with the view; the sort names one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, view, search, onlyEnabled, sort, preset, custom]);

  const open = (r: GoogleRow) => {
    if (view === "campaigns") {
      setCampaign({ id: r.id, name: r.name });
      setAdGroup(null);
      setView(r.sub === "Performance Max" ? "asset_groups" : "ad_groups");
    } else if (view === "ad_groups") {
      setAdGroup({ id: r.id, name: r.name });
      setView("ads");
    } else if (DETAILABLE.includes(view)) setDetail(r);
  };
  const exportCsv = () => {
    const head = [nameHeading[view], "Status", ...columns.map((c) => c.label)];
    const lines = rows.map((r) => [
      r.name,
      r.status.label,
      ...columns.map((c) => {
        const v = valueOf(c, r);
        return c.kind === "text" ? String(v ?? "") : formatValue(c.kind, v as number | null, currency);
      }),
    ]);
    const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\n");
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${viewLabel[view]} ${range.since} a ${range.until}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!accounts.length)
    return (
      <div className="campaign-tab-body">
        <p className="muted">
          Nenhuma conta do Google Ads vinculada aos ciclos desta campanha. Vincule a conta no
          ciclo para ver a plataforma aqui.
        </p>
      </div>
    );

  const showToggle = withToggle(view);
  return (
    <div className="gplat">
      <div className="mplat-top gplat-top">
        {accounts.length > 1 ? (
          <Select aria-label="Conta do Google Ads" value={account.id} onValueChange={(v) => { setAccountId(v); setCampaign(null); setAdGroup(null); }}>
            {accounts.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {`${a.name} (${formatCustomer(a.id)})`}
              </SelectOption>
            ))}
          </Select>
        ) : (
          <span className="mplat-account">
            {list?.account.name ?? account.name} <small>{formatCustomer(account.id)}</small>
          </span>
        )}
        <span className="mplat-period gplat-period">
          <Select aria-label="Período" value={period} onValueChange={(v) => setPeriod(v as DatePreset)}>
            {DATE_PRESETS.filter(([id]) => id !== "maximum" && (id !== "cycle" || current)).map(([id, label]) => (
              <SelectOption key={id} value={id}>
                {label}
              </SelectOption>
            ))}
          </Select>
          {period === "custom" ? (
            <>
              <Input type="date" aria-label="De" value={customRange.since} max={customRange.until} onChange={(e) => e.target.value && setCustomRange((r) => ({ ...r, since: e.target.value }))} />
              <Input type="date" aria-label="Até" value={customRange.until} min={customRange.since} max={today} onChange={(e) => e.target.value && setCustomRange((r) => ({ ...r, until: e.target.value }))} />
            </>
          ) : (
            <small className="mplat-range">
              {shortDate(range.since)} – {shortDate(range.until)}
            </small>
          )}
        </span>
        <Button
          className="btn secondary mplat-refresh"
          loading={loading && !!list}
          onClick={() => {
            setFresh(true);
            setRefresh((n) => n + 1);
          }}
          title={list ? `Lido do Google às ${new Date(list.fetched_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : undefined}
        >
          <RefreshCw size={15} /> Atualizar
        </Button>
      </div>

      <div className="gplat-body">
        <nav className="gplat-nav" aria-label="Visões do Google Ads">
          {MENU.map((g, gi) => (
            <div key={gi} className="gplat-nav-group">
              {g.label && <span className="gplat-nav-label">{g.label}</span>}
              {g.items.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={view === id ? "selected" : ""}
                  aria-current={view === id ? "page" : undefined}
                  onClick={() => {
                    setView(id);
                    setDetail(null);
                    setSort({ column: withMetrics(id) ? "cost" : "", desc: true });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <section className="gplat-main">
          <div className="gplat-crumbs" aria-label="Escopo">
            <button type="button" className={!campaign ? "current" : ""} onClick={() => { setCampaign(null); setAdGroup(null); }}>
              Todas as campanhas
            </button>
            {campaign && (
              <>
                <ChevronRight size={14} aria-hidden="true" />
                <span className="gplat-crumb">
                  <button type="button" className={!adGroup ? "current" : ""} onClick={() => setAdGroup(null)}>
                    Campanha: {campaign.name}
                  </button>
                  <button type="button" className="gplat-crumb-x" aria-label="Tirar a campanha" onClick={() => { setCampaign(null); setAdGroup(null); }}>
                    <X size={12} />
                  </button>
                </span>
              </>
            )}
            {adGroup && (
              <>
                <ChevronRight size={14} aria-hidden="true" />
                <span className="gplat-crumb">
                  <button type="button" className="current">Grupo de anúncios: {adGroup.name}</button>
                  <button type="button" className="gplat-crumb-x" aria-label="Tirar o grupo de anúncios" onClick={() => setAdGroup(null)}>
                    <X size={12} />
                  </button>
                </span>
              </>
            )}
          </div>
          <h3 className="gplat-title">{viewLabel[view]}</h3>

          <div className="mplat-toolbar gplat-toolbar">
            <span className="mplat-readonly" title="A conexão com o Google Ads é usada só para leitura">Somente visualização</span>
            <span className="mplat-search">
              <Input type="search" icon={Search} placeholder="Pesquisar" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Pesquisar" />
            </span>
            {showToggle && (
              <label className="mplat-check">
                <Checkbox checked={onlyEnabled} onCheckedChange={(v) => setOnlyEnabled(v === true)} />
                Só ativados
              </label>
            )}
            {showToggle && (
              <label className="mplat-check">
                <Checkbox checked={removed} onCheckedChange={(v) => setRemoved(v === true)} />
                Removidos
              </label>
            )}
            <span className="mplat-toolbar-right">
              {view === "locations" && (
                <Select aria-label="Tipo de local" value={geo} onValueChange={(v) => setGeo(v as typeof geo)}>
                  <SelectOption value="city">Cidades</SelectOption>
                  <SelectOption value="region">Estados e regiões</SelectOption>
                  <SelectOption value="country">Países</SelectOption>
                </Select>
              )}
              {withMetrics(view) && view !== "auction" && (
                <span className="mplat-labeled">
                  <Columns3 size={15} aria-hidden="true" />
                  <Select
                    aria-label="Colunas"
                    value={preset}
                    onValueChange={(v) => (v === "__choose" ? setChoosing(true) : setPreset(v as GPreset))}
                  >
                    {G_PRESETS.map((p) => (
                      <SelectOption key={p.id} value={p.id}>
                        {`Colunas: ${p.label}`}
                      </SelectOption>
                    ))}
                    <SelectOption value="personalizado">Colunas: Personalizadas</SelectOption>
                    <SelectOption value="__choose">Modificar colunas…</SelectOption>
                  </Select>
                </span>
              )}
              {SEGMENTABLE.includes(view) && (
                <span className="mplat-labeled">
                  <SlidersHorizontal size={15} aria-hidden="true" />
                  <Select aria-label="Segmentar" value={segment} onValueChange={(v) => setSegment(v as GoogleSegment | "")}>
                    <SelectOption value="">Segmentar: nenhum</SelectOption>
                    {SEGMENTS.map(([id, label]) => (
                      <SelectOption key={id} value={id}>
                        {`Segmentar: ${label}`}
                      </SelectOption>
                    ))}
                  </Select>
                </span>
              )}
              <Button className="btn secondary" onClick={exportCsv} disabled={!list}>
                <Download size={15} /> Fazer download
              </Button>
            </span>
          </div>
          {list?.notice && list.view === view && <p className="gplat-notice">{list.notice}</p>}

          {crmWanted && <CrmNotice crm={crm} state={crmState} />}
          {error ? (
            <div className="mplat-error" role="alert">
              <strong>Não foi possível ler o Google Ads.</strong> {error.message}
              {error.code === "not_connected" && <span> Conecte o Google Ads da agência em Campanhas › Conexões.</span>}
            </div>
          ) : !list || list.view !== view ? (
            <Loading variant="table" />
          ) : (
            <div className={`mplat-table-wrap ${loading ? "loading" : ""}`}>
              <table className="mplat-table gplat-table">
                <thead>
                  <tr>
                    {showToggle && <th className="mplat-sel gplat-dot-col" aria-label="Status" />}
                    <SortHeader id="" label={nameHeading[view]} sort={sort} onSort={setSort} className="mplat-name-col gplat-name-col" />
                    <th>Status</th>
                    {columns.map((c) => (
                      <SortHeader key={c.id} id={c.id} label={c.label} sort={sort} onSort={setSort} numeric={c.kind !== "text"} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={columns.length + 3} className="mplat-empty">
                        {list.rows.length ? "Nada com esse filtro." : `Nenhum ${rowNoun[view][0]} no período.`}
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <Fragment key={r.id}>
                      <tr>
                        {showToggle && (
                          <td className="mplat-sel gplat-dot-col">
                            <span
                              className={`gplat-dot ${r.enabled ? "on" : r.status.code === "REMOVED" ? "removed" : "off"}`}
                              title={r.enabled ? "Ativado" : r.status.code === "REMOVED" ? "Removido" : "Pausado"}
                              aria-label={r.enabled ? "Ativado" : "Pausado"}
                            />
                          </td>
                        )}
                        <td className="mplat-name-col gplat-name-col">
                          <NameCell row={r} view={view} linked={linked} onOpen={() => open(r)} onDetail={DETAILABLE.includes(view) ? () => setDetail(r) : undefined} />
                        </td>
                        <td>
                          <span className={`mplat-delivery ${r.status.tone}`}>
                            {r.status.label && <i aria-hidden="true" />}
                            {r.status.label || "—"}
                          </span>
                        </td>
                        {columns.map((c) => (
                          <GCell key={c.id} column={c} row={r} currency={currency} value={valueOf(c, r)} crmOpen={crmOpen} />
                        ))}
                      </tr>
                      {r.segments?.map((s) => (
                        <tr key={`${r.id}:${s.key}`} className="mplat-sub">
                          {showToggle && <td />}
                          <td className="mplat-name-col gplat-name-col">
                            <span className="mplat-sub-label">{segmentLabel(segment, s.label)}</span>
                          </td>
                          <td />
                          {columns.map((c) => (
                            <GCell key={c.id} column={c} row={{ ...r, metrics: s.metrics }} currency={currency} value={c.text ? null : (c.value?.(s.metrics) ?? null)} sub />
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
                {list.totals && (
                  <tfoot>
                    <tr>
                      {showToggle && <td />}
                      <td className="mplat-name-col gplat-name-col">
                        <strong>
                          Total: {rows.length} {rows.length === 1 ? rowNoun[view][0] : rowNoun[view][1]}
                        </strong>
                        {rows.length !== list.rows.length && <small className="mplat-foot-note">Total de todas as linhas do filtro</small>}
                      </td>
                      <td />
                      {columns.map((c) => (
                        <td key={c.id} className={c.kind === "text" ? "" : "num"}>
                          {c.text ? "" : formatValue(c.kind, c.value?.(list.totals!) ?? null, currency)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          {crmWanted && list && list.view === view && !error && (
            <CrmUnmatched
              level={crmLevel(view) ?? "campaign"}
              items={unmatched}
              money={(v) => formatValue("money", v, currency)}
              noun={view === "campaigns" ? "campanha nesta conta" : "grupo nestas campanhas"}
            />
          )}
        </section>
      </div>

      {detail && account && (
        <GoogleDrawer
          row={detail}
          view={view}
          company={company}
          account={account}
          backend={backend}
          range={range}
          currency={currency}
          onClose={() => setDetail(null)}
        />
      )}
      {choosing && (
        <ColumnChooser
          initial={preset === "personalizado" ? custom : metricIds}
          onClose={() => setChoosing(false)}
          onSave={(ids) => {
            setCustom(ids);
            setPreset("personalizado");
            setChoosing(false);
          }}
        />
      )}
    </div>
  );
}

const formatCustomer = (id: string) => id.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");
const shortDate = (d: string) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");
function segmentLabel(kind: GoogleSegment | "", label: string) {
  if (kind === "date") return shortDate(label);
  if (kind === "week") return `Semana de ${shortDate(label)}`;
  if (kind === "month") return label.slice(0, 7).split("-").reverse().join("/");
  return label;
}

function SortHeader({ id, label, sort, onSort, numeric, className = "" }: { id: string; label: string; sort: Sort; onSort: (s: Sort) => void; numeric?: boolean; className?: string }) {
  const active = sort.column === id;
  return (
    <th className={`${className} ${numeric ? "num" : ""}`} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => onSort({ column: id, desc: active ? !sort.desc : !!numeric })}>
        {label}
        {active && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </button>
    </th>
  );
}

function NameCell({
  row,
  view,
  linked,
  onOpen,
  onDetail,
}: {
  row: GoogleRow;
  view: GoogleView;
  linked: { now: Set<string>; all: Set<string> };
  onOpen: () => void;
  onDetail?: () => void;
}) {
  const clickable = view === "campaigns" || view === "ad_groups" || DETAILABLE.includes(view);
  const mark = view === "campaigns" && (linked.now.has(row.id) || linked.all.has(row.id));
  return (
    <div className="mplat-name">
      {(view === "ads" || view === "asset_groups") && row.preview?.images[0] ? (
        <span className="mplat-thumb" aria-hidden="true">
          <img src={row.preview.images[0]} alt="" loading="lazy" />
        </span>
      ) : null}
      <span className="mplat-name-text">
        {clickable ? (
          <button type="button" className="mplat-link gplat-link" onClick={onOpen} title={row.name}>
            {row.name}
          </button>
        ) : (
          <span className="gplat-plain" title={row.name}>{row.name}</span>
        )}
        {view === "ads" && row.preview && <AdPreview preview={row.preview} compact />}
        <span className="mplat-name-sub">
          {row.sub && view !== "ads" && <span>{row.sub}</span>}
          {mark && (
            <span className="mplat-linked" title={linked.now.has(row.id) ? "Vinculada ao ciclo atual desta campanha no MAVI" : "Vinculada a um ciclo anterior desta campanha no MAVI"}>
              <Link2 size={11} /> {linked.now.has(row.id) ? "No ciclo atual" : "Em ciclo anterior"}
            </span>
          )}
          {onDetail && (
            <button type="button" className="mplat-mini" onClick={onDetail}>
              <BarChart3 size={12} /> Ver gráficos
            </button>
          )}
        </span>
      </span>
    </div>
  );
}

/** Which UTM level a view's rows are (null: none, the CRM has no column). */
function crmLevel(view: GoogleView): CrmLevel | null {
  return view === "campaigns" ? "campaign" : CRM_VIEWS.includes(view) ? "adset" : null;
}
/** A Google row in UTMs: utm_campaign = campanha, utm_term = grupo. */
function crmKey(view: GoogleView, r: GoogleRow): CrmKey | null {
  const at = crmLevel(view);
  if (at === "campaign") return { campaign: r.name };
  if (at === "adset") return { campaign: String(r.info.campaign ?? ""), term: r.name };
  return null;
}

function GCell({
  column: c,
  row,
  currency,
  value,
  sub = false,
  crmOpen,
}: {
  column: GColumn;
  row: GoogleRow;
  currency: string;
  value: string | number | null;
  sub?: boolean;
  /** The opportunities' number opens them in the MakeCRM. */
  crmOpen?: (r: GoogleRow) => void;
}) {
  if (c.kind === "text") return <td className="mplat-text">{sub ? "" : value || "—"}</td>;
  if (!sub && c.id === "crm_leads" && crmOpen && typeof value === "number" && value > 0)
    return (
      <td className="num">
        <CrmLeadsLink value={value} label={formatValue(c.kind, value, currency)} onOpen={() => crmOpen(row)} />
      </td>
    );
  const wonDeals = row.metrics?.crm_won_deals;
  return (
    <td
      className="num"
      title={
        !sub && c.id === "crm_wons" && typeof wonDeals === "number"
          ? `${wonDeals.toLocaleString("pt-BR")} ${wonDeals === 1 ? "oportunidade ganha" : "oportunidades ganhas"} (o CRM conta um ganho por orçamento fechado)`
          : undefined
      }
    >
      {formatValue(c.kind, value as number | null, currency)}
    </td>
  );
}

/** A Google ad as it shows on the results page ("Patrocinado"). */
export function AdPreview({ preview, compact = false }: { preview: NonNullable<GoogleRow["preview"]>; compact?: boolean }) {
  const title = preview.headlines.slice(0, 3).join(" | ");
  const text = preview.descriptions.slice(0, compact ? 1 : 2).join(" ");
  return (
    <div className={`gplat-ad ${compact ? "compact" : ""}`}>
      <span className="gplat-ad-sponsor">Patrocinado</span>
      {(preview.business || preview.path) && (
        <span className="gplat-ad-site">
          {preview.business && <b>{preview.business}</b>}
          {preview.path && <span>{preview.path}</span>}
        </span>
      )}
      {title && <span className="gplat-ad-title">{title}</span>}
      {text && <span className="gplat-ad-text">{text}</span>}
    </div>
  );
}

function ColumnChooser({ initial, onClose, onSave }: { initial: string[]; onClose: () => void; onSave: (ids: string[]) => void }) {
  const [chosen, setChosen] = useState<string[]>(initial);
  return (
    <Modal title="Modificar colunas" onClose={onClose} wide>
      <div className="mplat-chooser">
        <p className="muted">Escolha as colunas (a ordem é a da escolha). Fica salvo neste navegador.</p>
        <div className="mplat-chooser-grid">
          {METRIC_COLUMNS.map((c) => (
            <label key={c.id} className="mplat-check">
              <Checkbox checked={chosen.includes(c.id)} onCheckedChange={(v) => setChosen((l) => (v === true ? [...l, c.id] : l.filter((x) => x !== c.id)))} />
              {c.label}
            </label>
          ))}
        </div>
        <div className="form-actions">
          <Button className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button className="btn primary" disabled={!chosen.length} onClick={() => onSave(chosen)}>
            Aplicar {chosen.length} {chosen.length === 1 ? "coluna" : "colunas"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ details
const COLORS = ["#1a73e8", "#e37400", "#188038", "#a142f4"];
function GoogleDrawer({
  row,
  view,
  company,
  account,
  backend,
  range,
  currency,
  onClose,
}: {
  row: GoogleRow;
  view: GoogleView;
  company: string;
  account: { id: string; manager: string };
  backend: GooglePlatformBackend;
  range: { since: string; until: string };
  currency: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<GoogleDetail | null>(null);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState<"clicks" | "cost" | "conversions" | "impressions">("clicks");
  useEffect(() => {
    let live = true;
    setDetail(null);
    setError("");
    const q = { account: account.id, manager: account.manager, view, id: row.id, since: range.since, until: range.until, campaigns: [], ad_groups: [] };
    cached(JSON.stringify(["gdetail", company, q]), () => backend.detail(company, q))
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [row.id, view, account.id, account.manager, company, backend, range.since, range.until]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const m = row.metrics ?? {};
  const display: Display | null = detail
    ? {
        keys: detail.days.map((d) => d.day),
        labels: detail.days.map((d) => `${d.day.slice(8, 10)}/${d.day.slice(5, 7)}`),
        series: [
          {
            id: "0",
            name: { clicks: "Cliques", cost: "Custo", conversions: "Conversões", impressions: "Impr." }[metric],
            color: COLORS[["clicks", "cost", "conversions", "impressions"].indexOf(metric)],
            unit: metric === "cost" ? "money" : "number",
            values: detail.days.map((d) => d.metrics[metric] ?? null),
          },
        ],
        unit: metric === "cost" ? "money" : "number",
        interval: "day",
      }
    : null;
  const spec: PanelSpec = { viz: "line", groupBy: "time", queries: [], unit: display?.unit ?? "number" };
  return (
    <aside className="mplat-drawer gplat-drawer" aria-label={`Detalhes de ${row.name}`}>
      <div className="mplat-drawer-head">
        <div>
          <small>{nameHeading[view]}</small>
          <h3>{row.name}</h3>
          <span className={`mplat-delivery ${row.status.tone}`}>
            <i aria-hidden="true" />
            {row.status.label}
          </span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
          <X size={20} />
        </button>
      </div>
      <div className="mplat-drawer-body">
        <dl className="mplat-stats">
          <Stat label="Cliques">{formatValue("count", m.clicks)}</Stat>
          <Stat label="Impr.">{formatValue("count", m.impressions)}</Stat>
          <Stat label="Custo">{formatValue("money", m.cost, currency)}</Stat>
          <Stat label="Conversões">{formatValue("decimal", m.conversions)}</Stat>
        </dl>
        <div className="mplat-metric-pick" role="radiogroup" aria-label="Gráfico">
          {(
            [
              ["clicks", "Cliques"],
              ["impressions", "Impr."],
              ["cost", "Custo"],
              ["conversions", "Conversões"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={metric === id} className={metric === id ? "selected" : ""} onClick={() => setMetric(id)}>
              {label}
            </button>
          ))}
        </div>
        {error ? (
          <p className="form-error">{error}</p>
        ) : !display ? (
          <Loading variant="chart" />
        ) : (
          <div className="mplat-chart">
            <PanelChart display={display} spec={spec} />
          </div>
        )}
        {detail && detail.devices.length > 0 && (
          <table className="mplat-mini-table">
            <thead>
              <tr>
                <th>Dispositivo</th>
                <th className="num">Cliques</th>
                <th className="num">Custo</th>
                <th className="num">Conversões</th>
              </tr>
            </thead>
            <tbody>
              {detail.devices.map((d) => (
                <tr key={d.key}>
                  <td>{d.label}</td>
                  <td className="num">{formatValue("count", d.metrics.clicks)}</td>
                  <td className="num">{formatValue("money", d.metrics.cost, currency)}</td>
                  <td className="num">{formatValue("decimal", d.metrics.conversions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {row.preview && (view === "ads" || view === "asset_groups") && (
          <section className="gplat-drawer-preview">
            <h4>Prévia</h4>
            <AdPreview preview={row.preview} />
            {row.preview.images.length > 0 && (
              <div className="gplat-images">
                {row.preview.images.slice(0, 12).map((src) => (
                  <img key={src} src={src} alt="" loading="lazy" />
                ))}
              </div>
            )}
            {row.preview.final_url && /^https:\/\//.test(row.preview.final_url) && (
              <a className="mplat-mini" href={row.preview.final_url} target="_blank" rel="noreferrer">
                URL final <ExternalLink size={12} />
              </a>
            )}
          </section>
        )}
        {row.preview?.assets && row.preview.assets.length > 0 && (
          <table className="mplat-mini-table">
            <thead>
              <tr>
                <th>Recurso</th>
                <th>Tipo</th>
                <th>Classificação</th>
              </tr>
            </thead>
            <tbody>
              {row.preview.assets.map((a, i) => (
                <tr key={i}>
                  <td>
                    {a.image ? <img className="gplat-asset-img" src={a.image} alt="" loading="lazy" /> : a.video ? <span>YouTube: {a.video}</span> : a.text}
                  </td>
                  <td>{a.type}</td>
                  <td>
                    <span className={`gplat-perf ${a.performance === "Melhor" ? "best" : a.performance === "Baixa" ? "low" : ""}`}>{a.performance}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </aside>
  );
}
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
