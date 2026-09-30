import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Columns3,
  Download,
  ExternalLink,
  Folder,
  Image as ImageIcon,
  LayoutGrid,
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
import {
  BREAKDOWN_GROUPS,
  COLUMNS,
  DATE_PRESETS,
  PREVIEW_FORMATS,
  PRESETS,
  cached,
  columnById,
  formatValue,
  levelLabel,
  presetRange,
  sortValue,
  textValue,
  totalValue,
  type Breakdown,
  type Column,
  type ColumnPreset,
  type DatePreset,
  type PlatformBackend,
  type PlatformDetail,
  type PlatformLevel,
  type PlatformList,
  type PlatformRow,
} from "./campaign-platform";
import "./campaign-platform.css";

/**
 * Campanhas › Plataforma: the client's Meta ad account as the Ads Manager
 * shows it (read only): campaigns, ad sets and ads, the column presets, the
 * breakdowns, the period, the selection that filters the next level, the
 * charts of a row and the ad's preview. The campaigns linked to this MAVI
 * campaign are marked.
 */

type Prefs = {
  level: PlatformLevel;
  preset: ColumnPreset;
  custom: string[];
  period: DatePreset;
  since: string;
  until: string;
};
const PREFS_KEY = "mavi:campanhas:plataforma";
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

type Filter = "all" | "active" | "delivered";
type Sort = { column: string; desc: boolean };

export function CampaignPlatform({
  company,
  cycles,
  current,
  backend,
  today,
}: {
  company: string;
  /** Oldest first: their links give the accounts and the linked campaigns. */
  cycles: AdCycle[];
  current: AdCycle | null;
  backend: PlatformBackend;
  today: string;
}) {
  // The accounts of the campaign's links (the current cycle's first).
  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const y of [current, ...[...cycles].reverse()])
      for (const l of y?.links ?? [])
        if (!seen.has(l.account_id))
          seen.set(l.account_id, l.account_name || l.account_id);
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [cycles, current]);
  const linked = useMemo(() => {
    const now = new Set((current?.links ?? []).map((l) => l.campaign_id));
    const all = new Set(cycles.flatMap((y) => y.links.map((l) => l.campaign_id)));
    return { now, all };
  }, [cycles, current]);

  const saved = useMemo(loadPrefs, []);
  const [account, setAccount] = useState(accounts[0]?.id ?? "");
  const [level, setLevel] = useState<PlatformLevel>(saved.level ?? "campaign");
  const [preset, setPreset] = useState<ColumnPreset>(saved.preset ?? "desempenho");
  const [custom, setCustom] = useState<string[]>(
    saved.custom?.length ? saved.custom : PRESETS[0].columns,
  );
  const [period, setPeriod] = useState<DatePreset>(saved.period ?? "last_7d");
  const [customRange, setCustomRange] = useState({
    since: saved.since ?? presetRange("last_7d", today)!.since,
    until: saved.until ?? presetRange("last_7d", today)!.until,
  });
  const [breakdown, setBreakdown] = useState<Breakdown | "">("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState<Sort>({ column: "spend", desc: true });
  const [selected, setSelected] = useState<Record<PlatformLevel, Set<string>>>({
    campaign: new Set(),
    adset: new Set(),
    ad: new Set(),
  });
  const [list, setList] = useState<PlatformList | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [detail, setDetail] = useState<PlatformRow | null>(null);
  const [choosingColumns, setChoosingColumns] = useState(false);

  useEffect(() => {
    if (!accounts.some((a) => a.id === account)) setAccount(accounts[0]?.id ?? "");
  }, [accounts, account]);
  useEffect(() => {
    savePrefs({
      level,
      preset,
      custom,
      period,
      since: customRange.since,
      until: customRange.until,
    });
  }, [level, preset, custom, period, customRange]);

  const range =
    period === "custom"
      ? customRange
      : period === "maximum"
        ? { since: "", until: "" }
        : (presetRange(period, today, current) ?? presetRange("last_7d", today)!);
  const parents = {
    campaigns: level === "campaign" ? [] : [...selected.campaign],
    adsets: level === "ad" ? [...selected.adset] : [],
  };
  const query = {
    account,
    level,
    since: range.since,
    until: range.until,
    ...(period === "maximum" ? { preset: "maximum" as const } : {}),
    campaigns: parents.campaigns,
    adsets: parents.adsets,
    ...(breakdown ? { breakdown } : {}),
    archived,
  };
  const key = JSON.stringify([company, query]);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (!account) return;
    let live = true;
    setLoading(true);
    setError(null);
    cached(key, () => backend.list(company, query), fresh)
      .then((l) => {
        if (!live) return;
        setList(l);
      })
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

  const columnIds =
    preset === "personalizado"
      ? custom
      : (PRESETS.find((p) => p.id === preset)?.columns ?? PRESETS[0].columns);
  const columns = columnIds
    .map((id) => columnById.get(id))
    .filter((c): c is Column => !!c && (!c.levels || c.levels.includes(level)));
  const currency = list?.account.currency ?? "BRL";

  const rows = useMemo(() => {
    if (!list) return [];
    const q = search.trim().toLocaleLowerCase("pt-BR");
    const filtered = list.rows.filter(
      (r) =>
        (!q ||
          r.name.toLocaleLowerCase("pt-BR").includes(q) ||
          r.id.includes(q)) &&
        (filter === "all" ||
          (filter === "active"
            ? r.delivery.tone === "on"
            : (r.metrics.impressions ?? 0) > 0)),
    );
    const col = columnById.get(sort.column) ?? columnById.get("spend")!;
    return [...filtered].sort((a, b) => {
      const va = col.id === "name" ? a.name : sortValue(col, a, currency);
      const vb = col.id === "name" ? b.name : sortValue(col, b, currency);
      const cmp =
        typeof va === "string" || typeof vb === "string"
          ? String(va).localeCompare(String(vb), "pt-BR")
          : (va as number) - (vb as number);
      return sort.desc ? -cmp : cmp;
    });
  }, [list, search, filter, sort, currency]);

  const selectedHere = selected[level];
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s[level]);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...s, [level]: next };
    });
  const toggleAll = () =>
    setSelected((s) => ({
      ...s,
      [level]:
        rows.length && rows.every((r) => s[level].has(r.id))
          ? new Set()
          : new Set(rows.map((r) => r.id)),
    }));
  const clear = (l: PlatformLevel) =>
    setSelected((s) => ({ ...s, [l]: new Set() }));
  const switchLevel = (l: PlatformLevel) => {
    setLevel(l);
    setDetail(null);
    // Meta's rule: a selection filters the levels below it only.
    if (l === "campaign") setSelected((s) => ({ ...s, adset: new Set(), ad: new Set() }));
    if (l === "adset") setSelected((s) => ({ ...s, ad: new Set() }));
  };

  const exportCsv = useCallback(() => {
    if (!list) return;
    const head = ["Nome", ...columns.map((c) => c.label)];
    const lines = rows.map((r) => [
      r.name,
      ...columns.map((c) =>
        c.kind === "text"
          ? textValue(c.id, r, currency)
          : formatValue(c.kind, c.value?.(r.metrics), currency),
      ),
    ]);
    const csv = [head, ...lines]
      .map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";"))
      .join("\n");
    const url = URL.createObjectURL(
      new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${levelLabel[level][0]} ${range.since || "maximo"} a ${range.until || today}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [list, rows, columns, currency, level, range.since, range.until, today]);

  if (!accounts.length)
    return (
      <div className="campaign-tab-body">
        <p className="muted">
          Nenhuma conta de anúncio vinculada aos ciclos desta campanha. Vincule
          a conta do Meta no ciclo para ver a plataforma aqui.
        </p>
      </div>
    );

  const levelCount = (l: PlatformLevel) =>
    l === "campaign" ? selected.campaign.size : l === "adset" ? selected.adset.size : selected.ad.size;
  const allChecked = rows.length > 0 && rows.every((r) => selectedHere.has(r.id));
  const someChecked = rows.some((r) => selectedHere.has(r.id));

  return (
    <div className="mplat">
      <div className="mplat-top">
        {accounts.length > 1 ? (
          <Select
            aria-label="Conta de anúncio"
            value={account}
            onValueChange={(v) => {
              setAccount(v);
              setSelected({ campaign: new Set(), adset: new Set(), ad: new Set() });
            }}
          >
            {accounts.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.name} ({a.id})
              </SelectOption>
            ))}
          </Select>
        ) : (
          <span className="mplat-account" title={`Conta ${account}`}>
            {list?.account.name ?? accounts[0].name}{" "}
            <small>({account})</small>
          </span>
        )}
        <span className="mplat-search">
          <Input
            type="search"
            icon={Search}
            placeholder="Pesquisar por nome ou identificação"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Pesquisar"
          />
        </span>
        <span className="mplat-period">
          <Select
            aria-label="Período"
            value={period}
            onValueChange={(v) => setPeriod(v as DatePreset)}
          >
            {DATE_PRESETS.filter(([id]) => id !== "cycle" || current).map(
              ([id, label]) => (
                <SelectOption key={id} value={id}>
                  {label}
                </SelectOption>
              ),
            )}
          </Select>
          {period === "custom" && (
            <>
              <Input
                type="date"
                aria-label="De"
                value={customRange.since}
                max={customRange.until}
                onChange={(e) =>
                  e.target.value &&
                  setCustomRange((r) => ({ ...r, since: e.target.value }))
                }
              />
              <Input
                type="date"
                aria-label="Até"
                value={customRange.until}
                min={customRange.since}
                max={today}
                onChange={(e) =>
                  e.target.value &&
                  setCustomRange((r) => ({ ...r, until: e.target.value }))
                }
              />
            </>
          )}
          {period !== "custom" && period !== "maximum" && (
            <small className="mplat-range">
              {shortDate(range.since)} – {shortDate(range.until)}
            </small>
          )}
        </span>
        <Button
          className="btn secondary mplat-refresh"
          onClick={() => {
            setFresh(true);
            setRefresh((t) => t + 1);
          }}
          loading={loading && !!list}
          title={
            list
              ? `Lido do Meta às ${new Date(list.fetched_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
              : undefined
          }
        >
          <RefreshCw size={15} /> Atualizar
        </Button>
      </div>

      <div className="mplat-levels" role="tablist" aria-label="Nível">
        {(
          [
            ["campaign", Folder],
            ["adset", LayoutGrid],
            ["ad", ImageIcon],
          ] as [PlatformLevel, typeof Folder][]
        ).map(([l, Icon]) => (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={level === l}
            className={level === l ? "selected" : ""}
            onClick={() => switchLevel(l)}
          >
            <Icon size={17} aria-hidden="true" />
            <span>
              {levelLabel[l][0]}
              {l !== level && levelCount(l) > 0 && (
                <small>
                  {" "}
                  para {levelCount(l)}{" "}
                  {levelCount(l) === 1 ? levelLabel[l][1] : levelLabel[l][0].toLocaleLowerCase("pt-BR")}
                </small>
              )}
            </span>
            {levelCount(l) > 0 && (
              <span
                className="mplat-chip"
                role="button"
                tabIndex={0}
                aria-label={`Limpar seleção de ${levelLabel[l][0]}`}
                onClick={(e) => {
                  e.stopPropagation();
                  clear(l);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    clear(l);
                  }
                }}
              >
                {levelCount(l)} {levelCount(l) === 1 ? "selecionado" : "selecionados"}
                <X size={12} />
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="mplat-toolbar">
        <span className="mplat-readonly" title="A conexão com o Meta é só de leitura">
          Somente visualização
        </span>
        <Select
          aria-label="Filtro de veiculação"
          value={filter}
          onValueChange={(v) => setFilter(v as Filter)}
        >
          <SelectOption value="all">Todos</SelectOption>
          <SelectOption value="active">Ativos</SelectOption>
          <SelectOption value="delivered">Com veiculação no período</SelectOption>
        </Select>
        <label className="mplat-check">
          <Checkbox
            checked={archived}
            onCheckedChange={(v) => setArchived(v === true)}
          />
          Arquivados
        </label>
        <span className="mplat-toolbar-right">
          <span className="mplat-labeled">
            <Columns3 size={15} aria-hidden="true" />
            <Select
              aria-label="Colunas"
              value={preset}
              onValueChange={(v) => {
                if (v === "__choose") {
                  setChoosingColumns(true);
                  return;
                }
                setPreset(v as ColumnPreset);
              }}
            >
              {PRESETS.map((p) => (
                <SelectOption key={p.id} value={p.id}>
                  Colunas: {p.label}
                </SelectOption>
              ))}
              <SelectOption value="personalizado">Colunas: Personalizadas</SelectOption>
              <SelectOption value="__choose">Personalizar colunas…</SelectOption>
            </Select>
          </span>
          <span className="mplat-labeled">
            <SlidersHorizontal size={15} aria-hidden="true" />
            <Select
              aria-label="Detalhamento"
              value={breakdown}
              onValueChange={(v) => setBreakdown(v as Breakdown | "")}
            >
              <SelectOption value="">Detalhamento: nenhum</SelectOption>
              {BREAKDOWN_GROUPS.flatMap((g) =>
                g.items.map(([id, label]) => (
                  <SelectOption key={id} value={id}>
                    {g.label}: {label}
                  </SelectOption>
                )),
              )}
            </Select>
          </span>
          <Button className="btn secondary" onClick={exportCsv} disabled={!list}>
            <Download size={15} /> Exportar
          </Button>
        </span>
      </div>

      {error ? (
        <div className="mplat-error" role="alert">
          <strong>Não foi possível ler o Meta.</strong> {error.message}
          {(error.code === "expired" || error.code === "not_connected") && (
            <span>
              {" "}
              Conecte o Facebook do cliente no topo da campanha para voltar a
              ver a plataforma.
            </span>
          )}
        </div>
      ) : !list ? (
        <Loading variant="table" />
      ) : (
        <div className={`mplat-table-wrap ${loading ? "loading" : ""}`}>
          <table className="mplat-table">
            <thead>
              <tr>
                <th className="mplat-sel">
                  <Checkbox
                    aria-label="Selecionar todos"
                    checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    onCheckedChange={toggleAll}
                  />
                </th>
                <th className="mplat-toggle-col" aria-label="Ativação" />
                <SortHeader
                  id="name"
                  label={levelLabel[level][1].replace(/^./, (c) => c.toUpperCase())}
                  sort={sort}
                  onSort={setSort}
                  className="mplat-name-col"
                />
                {columns.map((c) => (
                  <SortHeader
                    key={c.id}
                    id={c.id}
                    label={c.label}
                    sort={sort}
                    onSort={setSort}
                    numeric={c.kind !== "text"}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 3} className="mplat-empty">
                    {list.rows.length
                      ? "Nada com esse filtro."
                      : `Nenhum ${levelLabel[level][1]} ${
                          parents.campaigns.length || parents.adsets.length
                            ? "na seleção"
                            : "nesta conta"
                        }.`}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className={selectedHere.has(r.id) ? "checked" : ""}>
                    <td className="mplat-sel">
                      <Checkbox
                        aria-label={`Selecionar ${r.name}`}
                        checked={selectedHere.has(r.id)}
                        onCheckedChange={() => toggle(r.id)}
                      />
                    </td>
                    <td className="mplat-toggle-col">
                      <span
                        className={`mplat-switch ${isOn(r) ? "on" : ""}`}
                        role="switch"
                        aria-checked={isOn(r)}
                        aria-disabled="true"
                        title="Somente visualização: ligue ou desligue no Gerenciador de Anúncios"
                      />
                    </td>
                    <td className="mplat-name-col">
                      <div className="mplat-name">
                        {r.level === "ad" && (
                          <span className="mplat-thumb" aria-hidden="true">
                            {r.creative?.thumbnail ? (
                              <img src={r.creative.thumbnail} alt="" loading="lazy" />
                            ) : (
                              <ImageIcon size={16} />
                            )}
                          </span>
                        )}
                        <span className="mplat-name-text">
                          <button
                            type="button"
                            className="mplat-link"
                            onClick={() => setDetail(r)}
                            title={r.name}
                          >
                            {r.name}
                          </button>
                          <span className="mplat-name-sub">
                            {r.level !== "campaign" && (
                              <span title="Campanha">{r.campaign_name}</span>
                            )}
                            {(linked.now.has(r.campaign_id) ||
                              linked.all.has(r.campaign_id)) && (
                              <span
                                className="mplat-linked"
                                title={
                                  linked.now.has(r.campaign_id)
                                    ? "Vinculada ao ciclo atual desta campanha no MAVI"
                                    : "Vinculada a um ciclo anterior desta campanha no MAVI"
                                }
                              >
                                <Link2 size={11} />{" "}
                                {linked.now.has(r.campaign_id) ? "No ciclo atual" : "Em ciclo anterior"}
                              </span>
                            )}
                            <button
                              type="button"
                              className="mplat-mini"
                              onClick={() => setDetail(r)}
                            >
                              <BarChart3 size={12} /> Ver gráficos
                            </button>
                            {r.level !== "ad" && (
                              <button
                                type="button"
                                className="mplat-mini"
                                onClick={() => {
                                  setSelected((s) => ({
                                    ...s,
                                    [r.level]: new Set([r.id]),
                                  }));
                                  switchLevel(r.level === "campaign" ? "adset" : "ad");
                                }}
                              >
                                {r.level === "campaign" ? "Conjuntos" : "Anúncios"} →
                              </button>
                            )}
                          </span>
                        </span>
                      </div>
                    </td>
                    {columns.map((c) => (
                      <Cell key={c.id} column={c} row={r} currency={currency} />
                    ))}
                  </tr>
                  {r.breakdown?.map((b) => (
                    <tr key={`${r.id}:${b.key}`} className="mplat-sub">
                      <td />
                      <td />
                      <td className="mplat-name-col">
                        <span className="mplat-sub-label">
                          {breakdownLabel(breakdown, b.label)}
                        </span>
                      </td>
                      {columns.map((c) => (
                        <Cell
                          key={c.id}
                          column={c}
                          row={{ ...r, metrics: b.metrics }}
                          currency={currency}
                          sub
                        />
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td />
                <td />
                <td className="mplat-name-col">
                  <strong>
                    Resultados de {rows.length}{" "}
                    {rows.length === 1
                      ? levelLabel[level][1]
                      : levelLabel[level][0].toLocaleLowerCase("pt-BR")}
                  </strong>
                  {rows.length !== list.rows.length && (
                    <small className="mplat-foot-note">
                      Total da conta com o filtro de seleção
                    </small>
                  )}
                </td>
                {columns.map((c) => (
                  <td key={c.id} className={c.kind === "text" ? "" : "num"}>
                    {c.kind === "text" ? (
                      ""
                    ) : (
                      <>
                        {formatValue(c.kind, totalValue(c, list), currency)}
                        <small className="mplat-cell-sub">
                          {c.id === "results" || c.id === "cost_per_result"
                            ? list.result_label
                            : c.id === "reach"
                              ? "Pessoas"
                              : c.kind === "money" && c.id === "spend"
                                ? "Total usado"
                                : c.kind === "money" || c.kind === "decimal" || c.kind === "percent"
                                  ? "Por conta"
                                  : "Total"}
                        </small>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {detail && list && (
        <DetailPanel
          row={detail}
          company={company}
          account={account}
          backend={backend}
          range={range}
          maximum={period === "maximum"}
          currency={currency}
          onClose={() => setDetail(null)}
        />
      )}
      {choosingColumns && (
        <ColumnChooser
          level={level}
          initial={preset === "personalizado" ? custom : columnIds}
          onClose={() => setChoosingColumns(false)}
          onSave={(ids) => {
            setCustom(ids);
            setPreset("personalizado");
            setChoosingColumns(false);
          }}
        />
      )}
    </div>
  );
}

const isOn = (r: PlatformRow) =>
  r.delivery.tone === "on" ||
  r.delivery.code === "WITH_ISSUES" ||
  r.delivery.code === "PENDING_REVIEW" ||
  r.delivery.code === "IN_PROCESS";
const shortDate = (d: string) =>
  d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "";
function breakdownLabel(kind: Breakdown | "", label: string) {
  if (kind === "day") return shortDate(label);
  if (kind === "week" || kind === "month") {
    const [a, b] = label.split("|");
    return b ? `${shortDate(a)} – ${shortDate(b)}` : shortDate(a);
  }
  if (kind === "country") {
    try {
      return new Intl.DisplayNames(["pt-BR"], { type: "region" }).of(label) ?? label;
    } catch {
      return label;
    }
  }
  return label;
}

function SortHeader({
  id,
  label,
  sort,
  onSort,
  numeric,
  className = "",
}: {
  id: string;
  label: string;
  sort: Sort;
  onSort: (s: Sort) => void;
  numeric?: boolean;
  className?: string;
}) {
  const active = sort.column === id;
  return (
    <th
      className={`${className} ${numeric ? "num" : ""}`}
      aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        onClick={() =>
          onSort({ column: id, desc: active ? !sort.desc : numeric !== false && id !== "name" })
        }
      >
        {label}
        {active &&
          (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </button>
    </th>
  );
}

function Cell({
  column: c,
  row,
  currency,
  sub = false,
}: {
  column: Column;
  row: PlatformRow;
  currency: string;
  sub?: boolean;
}) {
  if (c.kind === "text") {
    if (c.id === "delivery" && !sub)
      return (
        <td>
          <span className={`mplat-delivery ${row.delivery.tone}`}>
            <i aria-hidden="true" />
            {row.delivery.label}
          </span>
        </td>
      );
    return <td className="mplat-text">{sub ? "" : textValue(c.id, row, currency)}</td>;
  }
  const value = c.value?.(row.metrics);
  return (
    <td className="num">
      {formatValue(c.kind, value, currency)}
      {!sub && (c.id === "results" || c.id === "cost_per_result") && row.result_label !== "—" && (
        <small className="mplat-cell-sub">
          {c.id === "cost_per_result" ? `Por ${row.result_label.toLocaleLowerCase("pt-BR")}` : row.result_label}
        </small>
      )}
    </td>
  );
}

// ------------------------------------------------------------ columns
function ColumnChooser({
  level,
  initial,
  onClose,
  onSave,
}: {
  level: PlatformLevel;
  initial: string[];
  onClose: () => void;
  onSave: (ids: string[]) => void;
}) {
  const [chosen, setChosen] = useState<string[]>(initial);
  const available = COLUMNS.filter((c) => !c.levels || c.levels.includes(level));
  return (
    <Modal title="Personalizar colunas" onClose={onClose} wide>
      <div className="mplat-chooser">
        <p className="muted">
          Escolha as colunas e a ordem (a ordem é a da escolha). Fica salvo
          neste navegador.
        </p>
        <div className="mplat-chooser-grid">
          {available.map((c) => (
            <label key={c.id} className="mplat-check">
              <Checkbox
                checked={chosen.includes(c.id)}
                onCheckedChange={(v) =>
                  setChosen((list) =>
                    v === true ? [...list, c.id] : list.filter((x) => x !== c.id),
                  )
                }
              />
              {c.label}
            </label>
          ))}
        </div>
        <div className="form-actions">
          <Button className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            className="btn primary"
            disabled={!chosen.length}
            onClick={() => onSave(chosen)}
          >
            Aplicar {chosen.length} {chosen.length === 1 ? "coluna" : "colunas"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ detail
type DetailTab = "desempenho" | "demografia" | "posicionamento" | "previa";
const COLORS = ["#1877f2", "#42b72a", "#f7b928", "#a879c9"];
function DetailPanel({
  row,
  company,
  account,
  backend,
  range,
  maximum,
  currency,
  onClose,
}: {
  row: PlatformRow;
  company: string;
  account: string;
  backend: PlatformBackend;
  range: { since: string; until: string };
  maximum: boolean;
  currency: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("desempenho");
  const [detail, setDetail] = useState<PlatformDetail | null>(null);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState<"results" | "spend" | "impressions">("results");
  useEffect(() => {
    let live = true;
    setDetail(null);
    setError("");
    const q = {
      account,
      level: row.level,
      id: row.id,
      since: range.since,
      until: range.until,
      ...(maximum ? { preset: "maximum" as const } : {}),
    };
    cached(JSON.stringify(["detail", company, q]), () => backend.detail(company, q))
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [row.id, row.level, account, company, backend, range.since, range.until, maximum]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs: [DetailTab, string][] = [
    ["desempenho", "Desempenho"],
    ["demografia", "Demografia"],
    ["posicionamento", "Posicionamento"],
    ...(row.level === "ad" ? ([["previa", "Pré-visualização"]] as [DetailTab, string][]) : []),
  ];
  const m = row.metrics;
  const cpr = m.results ? (m.spend ?? 0) / m.results : null;
  return (
    <aside className="mplat-drawer" aria-label={`Detalhes de ${row.name}`}>
      <div className="mplat-drawer-head">
        <div>
          <small>{levelLabel[row.level][1].replace(/^./, (c) => c.toUpperCase())}</small>
          <h3>{row.name}</h3>
          <span className={`mplat-delivery ${row.delivery.tone}`}>
            <i aria-hidden="true" />
            {row.delivery.label}
          </span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
          <X size={20} />
        </button>
      </div>
      <div className="mplat-drawer-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mplat-drawer-body">
        {tab === "desempenho" && (
          <>
            <dl className="mplat-stats">
              <Stat label={row.result_label === "—" ? "Resultados" : row.result_label}>
                {formatValue("count", m.results)}
              </Stat>
              <Stat label="Custo por resultado">{formatValue("money", cpr, currency)}</Stat>
              <Stat label="Alcance">{formatValue("count", m.reach)}</Stat>
              <Stat label="Valor usado">{formatValue("money", m.spend, currency)}</Stat>
            </dl>
            <div className="mplat-metric-pick" role="radiogroup" aria-label="Gráfico">
              {(
                [
                  ["results", "Resultados"],
                  ["spend", "Valor usado"],
                  ["impressions", "Impressões"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={metric === id}
                  className={metric === id ? "selected" : ""}
                  onClick={() => setMetric(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {error ? (
              <p className="form-error">{error}</p>
            ) : !detail ? (
              <Loading variant="chart" />
            ) : (
              <>
                <MiniChart
                  days={detail.days.map((d) => d.day)}
                  series={[
                    {
                      name:
                        metric === "results"
                          ? detail.result_label
                          : metric === "spend"
                            ? "Valor usado"
                            : "Impressões",
                      values: detail.days.map((d) => d.metrics[metric] ?? null),
                    },
                  ]}
                  unit={metric === "spend" ? "money" : "number"}
                />
                {metric === "results" && (
                  <MiniChart
                    days={detail.days.map((d) => d.day)}
                    series={[
                      {
                        name: "Custo por resultado",
                        values: detail.days.map((d) =>
                          d.metrics.results
                            ? (d.metrics.spend ?? 0) / d.metrics.results
                            : null,
                        ),
                      },
                    ]}
                    unit="money"
                    tone={1}
                  />
                )}
              </>
            )}
          </>
        )}
        {tab === "demografia" &&
          (error ? (
            <p className="form-error">{error}</p>
          ) : !detail ? (
            <Loading variant="chart" />
          ) : (
            <Demographics detail={detail} currency={currency} />
          ))}
        {tab === "posicionamento" &&
          (error ? (
            <p className="form-error">{error}</p>
          ) : !detail ? (
            <Loading variant="table" />
          ) : (
            <table className="mplat-mini-table">
              <thead>
                <tr>
                  <th>Posicionamento</th>
                  <th className="num">{detail.result_label === "—" ? "Resultados" : detail.result_label}</th>
                  <th className="num">Custo por resultado</th>
                  <th className="num">Impressões</th>
                  <th className="num">Valor usado</th>
                </tr>
              </thead>
              <tbody>
                {detail.placements.map((p) => (
                  <tr key={p.key}>
                    <td>{p.label}</td>
                    <td className="num">{formatValue("count", p.metrics.results)}</td>
                    <td className="num">
                      {formatValue(
                        "money",
                        p.metrics.results ? (p.metrics.spend ?? 0) / p.metrics.results : null,
                        currency,
                      )}
                    </td>
                    <td className="num">{formatValue("count", p.metrics.impressions)}</td>
                    <td className="num">{formatValue("money", p.metrics.spend, currency)}</td>
                  </tr>
                ))}
                {!detail.placements.length && (
                  <tr>
                    <td colSpan={5} className="mplat-empty">
                      Sem veiculação no período.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ))}
        {tab === "previa" && (
          <AdPreview
            row={row}
            company={company}
            account={account}
            backend={backend}
          />
        )}
      </div>
    </aside>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function MiniChart({
  days,
  series,
  unit,
  tone = 0,
}: {
  days: string[];
  series: { name: string; values: (number | null)[] }[];
  unit: "money" | "number";
  /** The first series' color. */
  tone?: number;
}) {
  const display: Display = {
    keys: days,
    labels: days.map((d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`),
    series: series.map((s, i) => ({
      id: String(i),
      name: s.name,
      color: COLORS[(i + tone) % COLORS.length],
      unit,
      values: s.values,
    })),
    unit,
    interval: "day",
  };
  const spec: PanelSpec = { viz: "line", groupBy: "time", queries: [], unit };
  return (
    <div className="mplat-chart">
      <PanelChart display={display} spec={spec} />
    </div>
  );
}

function Demographics({ detail, currency }: { detail: PlatformDetail; currency: string }) {
  const [metric, setMetric] = useState<"results" | "spend" | "impressions">("results");
  const ages = [...new Set(detail.age_gender.map((r) => r.age))].sort();
  const value = (age: string, gender: string) =>
    detail.age_gender
      .filter((r) => r.age === age && r.gender === gender)
      .reduce((s, r) => s + (r.metrics[metric] ?? 0), 0);
  const display: Display = {
    keys: ages,
    labels: ages,
    series: [
      ["female", "Mulheres", "#a879c9"],
      ["male", "Homens", "#1877f2"],
      ["unknown", "Desconhecido", "#b0b7bd"],
    ]
      .filter(([g]) => detail.age_gender.some((r) => r.gender === g))
      .map(([g, name, color]) => ({
        id: g,
        name,
        color,
        unit: metric === "spend" ? "money" : "number",
        values: ages.map((a) => value(a, g)),
      })),
    unit: metric === "spend" ? "money" : "number",
    interval: "day",
  };
  const spec: PanelSpec = {
    viz: "bar",
    groupBy: "client",
    queries: [],
    unit: display.unit,
  };
  void currency;
  return (
    <>
      <div className="mplat-metric-pick" role="radiogroup" aria-label="Métrica">
        {(
          [
            ["results", detail.result_label === "—" ? "Resultados" : detail.result_label],
            ["spend", "Valor usado"],
            ["impressions", "Impressões"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={metric === id}
            className={metric === id ? "selected" : ""}
            onClick={() => setMetric(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {ages.length ? (
        <div className="mplat-chart">
          <PanelChart display={display} spec={spec} />
        </div>
      ) : (
        <p className="muted">Sem veiculação no período.</p>
      )}
    </>
  );
}

function AdPreview({
  row,
  company,
  account,
  backend,
}: {
  row: PlatformRow;
  company: string;
  account: string;
  backend: PlatformBackend;
}) {
  const [format, setFormat] = useState(PREVIEW_FORMATS[0][0]);
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    setError("");
    cached(JSON.stringify(["preview", company, account, row.id, format]), () =>
      backend.preview(company, account, row.id, format),
    )
      .then((p) => live && setSrc(p.src))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [company, account, row.id, format, backend]);
  const tall = /STORY|REELS/.test(format);
  return (
    <div className="mplat-preview">
      <Select aria-label="Posicionamento da prévia" value={format} onValueChange={setFormat}>
        {PREVIEW_FORMATS.map(([id, label]) => (
          <SelectOption key={id} value={id}>
            {label}
          </SelectOption>
        ))}
      </Select>
      {error ? (
        <p className="form-error">{error}</p>
      ) : src === undefined ? (
        <Loading variant="detail" />
      ) : src ? (
        <iframe
          title={`Prévia de ${row.name}`}
          src={src}
          className={tall ? "tall" : ""}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="mplat-preview-fallback">
          {row.creative?.thumbnail && <img src={row.creative.thumbnail} alt="" />}
          {row.creative?.title && <strong>{row.creative.title}</strong>}
          {row.creative?.body && <p>{row.creative.body}</p>}
          <p className="muted">
            O Meta não mandou a prévia deste posicionamento.
          </p>
        </div>
      )}
      {row.creative?.link && /^https:\/\//.test(row.creative.link) && (
        <a href={row.creative.link} target="_blank" rel="noreferrer" className="mplat-mini">
          Ver a publicação <ExternalLink size={12} />
        </a>
      )}
    </div>
  );
}
