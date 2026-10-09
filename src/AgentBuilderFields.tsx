import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Plus, TriangleAlert, X } from "lucide-react";
import { Checkbox, Input, Select, SelectOption, Textarea } from "./ui";
import { draftGet, linesOf, priceText, PROVIDER_LABEL, refKind, type AgentDraft, type AgentModels } from "./agent-builder";
import { DAYS, FIELDS, HALF_HOURS, type DayKey, type FieldDef, type FieldOption, type WeeklyHours } from "./agent-fields";

/**
 * Os campos do construtor, montados pelo catálogo (src/agent-fields.ts):
 * menus com a explicação da opção escolhida, sugestões de um clique, horário
 * da semana dia a dia e as caixas de marcar do sistema.
 */

export type FormProps = {
  draft: AgentDraft;
  change: (path: string, value: unknown) => void;
  errorFor: (path: string) => string | undefined;
};

const OTHER = "__outro";

function Field({ label, hint, error, children, wide }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`ab-field ${error ? "invalid" : ""} ${wide ? "wide" : ""}`}>
      <span className="ab-label">{label}</span>
      {children}
      {hint && !error && <small className="ab-hint">{hint}</small>}
      {error && <small className="ab-error">{error}</small>}
    </div>
  );
}

/** Texto com opções prontas + "Outro…" (escreve o seu). */
function PresetText({ f, p }: { f: Extract<FieldDef, { kind: "text" }>; p: FormProps }) {
  const raw = draftGet(p.draft, f.path) as string | undefined;
  const current = raw ?? f.fallback ?? "";
  const preset = f.presets!.find((o) => o.value === current);
  const [other, setOther] = useState(!preset && !!current);
  useEffect(() => {
    if (preset) setOther(false);
  }, [preset]);
  const value = other ? OTHER : (preset?.value ?? "");
  return (
    <Field label={f.label} hint={other ? f.hint : (preset?.hint ?? f.hint)} error={p.errorFor(f.path)}>
      <Select
        value={value}
        aria-label={f.label}
        onValueChange={(v) => {
          if (v === OTHER) {
            setOther(true);
            return;
          }
          setOther(false);
          p.change(f.path, v === f.fallback ? undefined : v || undefined);
        }}
      >
        {!f.fallback && <SelectOption value="">Escolha…</SelectOption>}
        {f.presets!.map((o) => (
          <SelectOption key={o.value} value={o.value}>
            {o.label}
          </SelectOption>
        ))}
        <SelectOption value={OTHER}>Outro (escrever)…</SelectOption>
      </Select>
      {other && (
        <Input
          autoFocus
          value={preset ? "" : current}
          maxLength={f.max}
          placeholder="Escreva do seu jeito"
          onChange={(e) => p.change(f.path, e.target.value || undefined)}
        />
      )}
    </Field>
  );
}

function OptionSelect({ f, p }: { f: Extract<FieldDef, { kind: "enum" | "number" }>; p: FormProps }) {
  const raw = draftGet(p.draft, f.path);
  const fallback = String(f.fallback);
  const current = raw === undefined || raw === null ? fallback : String(raw);
  const known = f.options.find((o) => o.value === current);
  const options: FieldOption[] = known ? f.options : [...f.options, { value: current, label: `Personalizado (${current})` }];
  const chosen = options.find((o) => o.value === current);
  return (
    <Field label={f.label} hint={chosen?.hint ?? f.hint} error={p.errorFor(f.path)}>
      <Select
        value={current}
        aria-label={f.label}
        onValueChange={(v) => {
          const val = f.kind === "number" ? Number(v) : v;
          p.change(f.path, v === fallback ? undefined : val);
        }}
      >
        {options.map((o) => (
          <SelectOption key={o.value} value={o.value}>
            {o.label}
          </SelectOption>
        ))}
      </Select>
    </Field>
  );
}

/** Os modelos liberados no Painel da MAVI › Agentes MAVI (o editor carrega e passa). */
export const ModelOptionsContext = createContext<AgentModels | null>(null);

/** "openai/gpt-5.2" (formato antigo) vira "openrouter:openai/gpt-5.2". */
export function normalizeRef(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  const i = s.indexOf(":");
  if (i > 0 && s.slice(0, i) in PROVIDER_LABEL) return s;
  return s.includes("/") ? `openrouter:${s}` : `openai:${s}`;
}

function ModelField({ f, p }: { f: Extract<FieldDef, { kind: "model" }>; p: FormProps }) {
  const ctx = useContext(ModelOptionsContext);
  const ref = normalizeRef(draftGet(p.draft, f.path));
  const allowed = (ctx?.models ?? []).filter((m) => m.allowed);
  const defKey = f.path === "model.model" ? ctx?.default : ctx?.fallback;
  const def = ctx?.models.find((m) => m.key === defKey);
  const current = allowed.find((m) => m.ref === ref);
  const blocked = !!ref && !current;
  const hint = current
    ? `${PROVIDER_LABEL[current.kind] ?? current.kind} · ${priceText(current)}`
    : !ref
      ? def
        ? `Hoje: ${def.label} (${PROVIDER_LABEL[def.kind] ?? def.kind}) · ${priceText(def)}`
        : "O motor usa o modelo dele."
      : undefined;
  return (
    <Field label={f.label} hint={hint ?? f.hint} error={p.errorFor(f.path)}>
      <Select value={ref} aria-label={f.label} onValueChange={(v) => p.change(f.path, v || undefined)}>
        <SelectOption value="">{`Padrão do Painel${def ? ` (${def.label})` : ""}`}</SelectOption>
        {allowed.map((m) => (
          <SelectOption key={m.key} value={m.ref}>
            {`${m.label} — ${m.provider_name}`}
          </SelectOption>
        ))}
        {blocked ? <SelectOption value={ref}>{`${ref} (não liberado)`}</SelectOption> : null}
      </Select>
      {blocked && (
        <small className="ab-error">
          <TriangleAlert size={12} aria-hidden="true" /> Este modelo não está liberado no Painel da MAVI. A versão publicada continua
          rodando, mas para publicar de novo escolha um liberado.
        </small>
      )}
    </Field>
  );
}

function BoolField({ f, p }: { f: Extract<FieldDef, { kind: "bool" }>; p: FormProps }) {
  const v = draftGet(p.draft, f.path);
  const checked = v === undefined ? f.fallback : !!v;
  const id = `ab-${f.path}`;
  return (
    <div className="ab-check">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => p.change(f.path, (c === true) === f.fallback ? undefined : c === true)} />
      <label htmlFor={id}>
        <span>{f.label}</span>
        {f.hint && <small className="ab-hint">{f.hint}</small>}
      </label>
    </div>
  );
}

function AreaField({ f, p }: { f: Extract<FieldDef, { kind: "area" }>; p: FormProps }) {
  const value = String(draftGet(p.draft, f.path) ?? "");
  return (
    <Field label={f.label} hint={f.hint} error={p.errorFor(f.path)} wide>
      {f.templates && !value.trim() && (
        <div className="ab-suggest">
          <span className="ab-hint">Começar com um modelo:</span>
          {f.templates.map((t) => (
            <button key={t.label} type="button" className="ab-chip" onClick={() => p.change(f.path, t.value)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <Textarea
        value={value}
        rows={f.max > 5000 ? 8 : f.max > 2000 ? 5 : 3}
        maxLength={f.max}
        placeholder={f.placeholder}
        onChange={(e) => p.change(f.path, e.target.value)}
      />
      {f.append && (
        <div className="ab-suggest">
          {f.append
            .filter((a) => !value.includes(a))
            .map((a) => (
              <button key={a} type="button" className="ab-chip" onClick={() => p.change(f.path, [value.trim(), a].filter(Boolean).join("\n"))}>
                <Plus size={12} aria-hidden="true" /> {a}
              </button>
            ))}
        </div>
      )}
    </Field>
  );
}

function ListField({ f, p }: { f: Extract<FieldDef, { kind: "list" }>; p: FormProps }) {
  const list: string[] = draftGet(p.draft, f.path) ?? [];
  const [text, setText] = useState(list.join("\n"));
  const joined = list.join("\n");
  useEffect(() => {
    if (linesOf(text).join("\n") !== joined) setText(joined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  const missing = f.suggestions.filter((s) => !list.includes(s));
  return (
    <Field label={f.label} hint={f.hint ?? "Uma por linha."} error={p.errorFor(f.path)} wide>
      <Textarea
        value={text}
        rows={Math.min(10, Math.max(3, list.length + 1))}
        placeholder={f.placeholder}
        onChange={(e) => {
          setText(e.target.value);
          p.change(f.path, linesOf(e.target.value));
        }}
      />
      {missing.length > 0 && (
        <div className="ab-suggest">
          <span className="ab-hint">Sugestões:</span>
          {missing.map((s) => (
            <button key={s} type="button" className="ab-chip" onClick={() => p.change(f.path, [...list, s])}>
              <Plus size={12} aria-hidden="true" /> {s}
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

function ChipsField({ f, p }: { f: Extract<FieldDef, { kind: "chips" }>; p: FormProps }) {
  const list: string[] = draftGet(p.draft, f.path) ?? [];
  const [adding, setAdding] = useState("");
  const set = (next: string[]) => p.change(f.path, next.length ? next : undefined);
  const add = (v: string) => {
    const s = v.trim().slice(0, f.maxLen);
    if (s && !list.includes(s) && list.length < f.maxItems) set([...list, s]);
  };
  return (
    <Field label={f.label} hint={f.hint} error={p.errorFor(f.path)} wide>
      <div className="ab-suggest">
        {list.map((s) => (
          <span key={s} className="ab-chip on">
            {s}
            <button type="button" aria-label={`Tirar ${s}`} onClick={() => set(list.filter((x) => x !== s))}>
              <X size={12} />
            </button>
          </span>
        ))}
        {f.suggestions
          .filter((s) => !list.includes(s))
          .map((s) => (
            <button key={s} type="button" className="ab-chip" onClick={() => add(s)}>
              <Plus size={12} aria-hidden="true" /> {s}
            </button>
          ))}
      </div>
      <Input
        value={adding}
        placeholder="Outro dado (Enter para incluir)"
        maxLength={f.maxLen}
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(adding);
            setAdding("");
          }
        }}
      />
    </Field>
  );
}

const WEEKDAYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri"];
const HOUR_PRESETS: { label: string; value: WeeklyHours }[] = [
  {
    label: "Comercial (seg a sex, 9h às 18h)",
    value: { ...Object.fromEntries(WEEKDAYS.map((d) => [d, { from: "09:00", to: "18:00" }])), sat: null, sun: null },
  },
  {
    label: "Comercial + sábado de manhã",
    value: { ...Object.fromEntries(WEEKDAYS.map((d) => [d, { from: "09:00", to: "18:00" }])), sat: { from: "09:00", to: "12:00" }, sun: null },
  },
  { label: "Todos os dias, 8h às 22h", value: Object.fromEntries(DAYS.map(([d]) => [d, { from: "08:00", to: "22:00" }])) as WeeklyHours },
];

/** O horário da semana dia a dia (usado nos horários da empresa e nos da agenda). */
export function WeeklyHoursEditor({ value, onChange }: { value: WeeklyHours | null | undefined; onChange: (v: WeeklyHours | undefined) => void }) {
  const uid = useId();
  const hours: WeeklyHours = value ?? {};
  const set = (next: WeeklyHours) => onChange(Object.keys(next).length ? next : undefined);
  const day = (d: DayKey, v: { from: string; to: string } | null | undefined) => {
    const next = { ...hours };
    if (v === undefined) delete next[d];
    else next[d] = v;
    set(next);
  };
  return (
    <>
      <div className="ab-suggest">
        <span className="ab-hint">Atalhos:</span>
        {HOUR_PRESETS.map((h) => (
          <button key={h.label} type="button" className="ab-chip" onClick={() => set(h.value)}>
            {h.label}
          </button>
        ))}
        {Object.keys(hours).length > 0 && (
          <button type="button" className="ab-chip" onClick={() => set({})}>
            Limpar
          </button>
        )}
      </div>
      <div className="ab-hours">
        {DAYS.map(([d, name]) => {
          const v = hours[d];
          const open = !!v;
          const id = `${uid}-${d}`;
          return (
            <div key={d} className={`ab-hours-row ${open ? "" : "closed"}`}>
              <span className="ab-check compact">
                <Checkbox id={id} checked={open} onCheckedChange={(c) => day(d, c === true ? (v ?? { from: "09:00", to: "18:00" }) : null)} />
                <label htmlFor={id}>{name}</label>
              </span>
              {open ? (
                <span className="ab-hours-times">
                  <select className="ui-input ab-time" aria-label={`${name}: das`} value={v.from} onChange={(e) => day(d, { ...v, from: e.target.value })}>
                    {HALF_HOURS.filter((t) => t < v.to).map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <span className="ab-hint">às</span>
                  <select className="ui-input ab-time" aria-label={`${name}: às`} value={v.to} onChange={(e) => day(d, { ...v, to: e.target.value })}>
                    {[...HALF_HOURS.filter((t) => t > v.from), "23:59"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </span>
              ) : (
                <span className="ab-hint">{v === null ? "Fechado" : "Não informado"}</span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function HoursField({ f, p }: { f: Extract<FieldDef, { kind: "hours" }>; p: FormProps }) {
  return (
    <Field label={f.label} hint={f.hint} error={p.errorFor(f.path)} wide>
      <WeeklyHoursEditor value={draftGet(p.draft, f.path)} onChange={(v) => p.change(f.path, v)} />
    </Field>
  );
}

export function FieldControl({ f, p }: { f: FieldDef; p: FormProps }) {
  switch (f.kind) {
    case "text":
      if (f.presets) return <PresetText f={f} p={p} />;
      return (
        <Field label={f.label} hint={f.hint} error={p.errorFor(f.path)}>
          <Input
            value={String(draftGet(p.draft, f.path) ?? "")}
            maxLength={f.max}
            placeholder={f.placeholder ?? f.fallback}
            onChange={(e) => p.change(f.path, e.target.value)}
          />
        </Field>
      );
    case "area":
      return <AreaField f={f} p={p} />;
    case "list":
      return <ListField f={f} p={p} />;
    case "chips":
      return <ChipsField f={f} p={p} />;
    case "enum":
    case "number":
      return <OptionSelect f={f} p={p} />;
    case "model":
      return <ModelField f={f} p={p} />;
    case "bool":
      return <BoolField f={f} p={p} />;
    case "hours":
      return <HoursField f={f} p={p} />;
  }
}

const SECTION_INTRO: Record<string, string> = {
  "Quem é o agente": "A personalidade com que ele fala com os leads.",
  "A empresa": "O básico do negócio. Detalhes (preços, catálogo) vão em Conhecimento.",
  "Objetivo e roteiro": "O que o agente precisa conseguir e por onde ele conduz a conversa.",
  Horários: "",
  Regras: "Comportamentos que valem em toda conversa. Clique nas sugestões para incluir.",
  "Texto livre": "",
  Conhecimento: "Como o agente usa a base de conhecimento.",
  Memória: "",
  "Mensagens do lead": "",
  Respostas: "",
  "Passar para uma pessoa": "",
  Inteligência: "Deixe no padrão se não tiver motivo para mudar.",
};

/** Os campos de uma aba, por seção. */
export function CatalogForm({ tab, p }: { tab: FieldDef["tab"]; p: FormProps }) {
  const sections = useMemo(() => {
    const by = new Map<string, FieldDef[]>();
    for (const f of FIELDS.filter((x) => x.tab === tab)) by.set(f.section, [...(by.get(f.section) ?? []), f]);
    return [...by.entries()];
  }, [tab]);
  return (
    <>
      {sections.map(([title, fields]) => (
        <section key={title} className="ab-section">
          <h3>{title}</h3>
          {SECTION_INTRO[title] && <p className="ab-hint ab-section-intro">{SECTION_INTRO[title]}</p>}
          <div className="ab-grid">
            {fields.map((f) => (
              <FieldControl key={f.path} f={f} p={p} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
