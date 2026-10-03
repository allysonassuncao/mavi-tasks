import { Checkbox, Input, Select, SelectOption } from "./ui";
import {
  compareOptions,
  datesLabel,
  rangeOptions,
  resolveCompare,
  resolveRange,
  type DashboardCompare,
  type DashboardRange,
} from "./dashboards";

/**
 * The dashboard's period and comparison, the same in the app and on the
 * shared link: ready periods or dates of one's own (De/Até), and what the
 * period is compared with — the previous period, the same days of the month
 * before, or dates of one's own.
 */

function Dates({
  from,
  to,
  onChange,
  label,
}: {
  from: string;
  to: string;
  onChange: (r: { from: string; to: string }) => void;
  label: string;
}) {
  return (
    <span className="dash-custom-range">
      <Input
        type="date"
        aria-label={`${label}: de`}
        value={from}
        max={to}
        onChange={(e) => e.target.value && onChange({ from: e.target.value, to })}
      />
      <span aria-hidden="true">–</span>
      <Input
        type="date"
        aria-label={`${label}: até`}
        value={to}
        min={from}
        onChange={(e) => e.target.value && onChange({ from, to: e.target.value })}
      />
    </span>
  );
}

export function PeriodPicker({
  range,
  tz,
  onChange,
}: {
  range: DashboardRange | undefined;
  tz: string;
  onChange: (r: DashboardRange) => void;
}) {
  const custom = !!range && "from" in range;
  return (
    <>
      <Select
        aria-label="Período"
        value={custom ? "custom" : (range?.preset ?? "30d")}
        onValueChange={(v) => {
          if (v === "custom") onChange(resolveRange(range, tz));
          else onChange({ preset: v as never });
        }}
      >
        {rangeOptions.map((r) => (
          <SelectOption key={r.key} value={r.key}>
            {r.label}
          </SelectOption>
        ))}
        <SelectOption value="custom">Personalizado</SelectOption>
      </Select>
      {custom && range && "from" in range && (
        <Dates {...range} label="Período" onChange={onChange} />
      )}
    </>
  );
}

const compareName = (c: DashboardCompare) =>
  "from" in c
    ? "Datas personalizadas"
    : (compareOptions.find((o) => o.key === c.preset)?.label ?? "");

/**
 * "Comparar com". open: whoever views picks; otherwise the comparison saved
 * in the dashboard is just shown (or nothing, without one). With onOpen
 * (editing), whoever edits says whether viewers may change it.
 */
export function ComparePicker({
  compare,
  range,
  onChange,
  open,
  allowViewers,
  onAllowViewers,
}: {
  compare: DashboardCompare | null | undefined;
  /** The period, as dates. */
  range: { from: string; to: string };
  onChange: (c: DashboardCompare | null) => void;
  open: boolean;
  allowViewers?: boolean;
  onAllowViewers?: (on: boolean) => void;
}) {
  const dates = resolveCompare(compare, range);
  if (!open)
    return compare && dates ? (
      <span className="dash-compare-fixed" title={datesLabel(dates)}>
        Comparando com {compareName(compare).toLowerCase()}{" "}
        <small>({datesLabel(dates)})</small>
      </span>
    ) : null;
  const custom = !!compare && "from" in compare;
  return (
    <span className="dash-compare">
      <Select
        aria-label="Comparar com"
        value={compare ? (custom ? "custom" : compare.preset) : "none"}
        onValueChange={(v) => {
          if (v === "none") onChange(null);
          else if (v === "custom")
            onChange(dates ?? resolveCompare({ preset: "previous" }, range));
          else onChange({ preset: v as never });
        }}
      >
        <SelectOption value="none">Sem comparação</SelectOption>
        {compareOptions.map((o) => (
          <SelectOption key={o.key} value={o.key}>
            Comparar: {o.label.toLowerCase()}
          </SelectOption>
        ))}
        <SelectOption value="custom">Comparar: datas personalizadas</SelectOption>
      </Select>
      {custom && compare && "from" in compare ? (
        <Dates {...compare} label="Comparar com" onChange={onChange} />
      ) : (
        dates && <small className="dash-compare-dates">{datesLabel(dates)}</small>
      )}
      {onAllowViewers && (
        <label className="checkbox-label dash-compare-open">
          <Checkbox
            checked={!!allowViewers}
            onCheckedChange={(on) => onAllowViewers(on === true)}
          />
          Quem vê pode mudar a comparação
        </label>
      )}
    </span>
  );
}
