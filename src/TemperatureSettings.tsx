import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  GraduationCap,
  Info,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Thermometer,
  Trash2,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import type { Snapshot } from "./types";
import {
  DEFAULT_BANDS,
  dateBr,
  deleteTemperatureLesson,
  loadTemperatureConfig,
  loadTemperatureLearning,
  saveTemperatureConfig,
  saveTemperatureLesson,
  type TemperatureFeedback,
  type TemperatureLearning,
  type TemperatureLesson,
  type IndicatorConfig,
  type ProductRule,
  type TemperatureConfig,
  type TemperatureReason,
  type TemperatureSource,
} from "./temperature";

type Draft = Pick<TemperatureConfig, "settings" | "indicators" | "rules">;
const money = (v: number) =>
  Number(v) > 0 && Number(v) < 0.01
    ? "< US$ 0,01"
    : `US$ ${Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (v: number) => Number(v || 0).toLocaleString("pt-BR");
let tempId = 0;
const newKey = () => `novo-${++tempId}`;

function blankIndicator(kind: "score" | "flag", product: string | null): IndicatorConfig & { _key: string } {
  return {
    _key: newKey(),
    product_id: product,
    kind,
    name: "",
    description: "",
    levels: kind === "score" ? ["", "", ""] : [],
    weight: kind === "score" ? 2 : 1,
    sources: ["meeting", "whatsapp"],
    alert: kind === "flag",
    active: true,
  };
}
const keyOf = (i: IndicatorConfig & { _key?: string }) => i.id ?? i._key ?? i.key ?? "";

/**
 * Painel da MAVI › Termômetro (administradores e gestores): a escala, o
 * cálculo, os indicadores e os sinais de alerta que o Jev avalia, os
 * assuntos e o ajuste de cada produto. Mudou uma pergunta, a MAVI relê o
 * histórico com o Jev; mudou só peso, faixa ou janela, só o cálculo refaz.
 */
export function TemperatureSettings({
  company,
  data,
  notify,
}: {
  company: string;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const [config, setConfig] = useState<TemperatureConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [product, setProduct] = useState("");

  function reset(c: TemperatureConfig) {
    setConfig(c);
    setDraft(structuredClone({ settings: c.settings, indicators: c.indicators, rules: c.rules }));
  }
  useEffect(() => {
    loadTemperatureConfig(company)
      .then(reset)
      .catch((e) => setError((e as Error).message));
  }, [company]);

  const dirty = useMemo(
    () =>
      !!config &&
      !!draft &&
      JSON.stringify({ settings: config.settings, indicators: config.indicators, rules: config.rules }) !==
        JSON.stringify(draft),
    [config, draft],
  );

  if (!config || !draft)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading variant="form" />
    );
  const s = draft.settings;
  const setSettings = (patch: Partial<Draft["settings"]>) =>
    setDraft({ ...draft, settings: { ...s, ...patch } });
  const setIndicators = (fn: (list: IndicatorConfig[]) => IndicatorConfig[]) =>
    setDraft({ ...draft, indicators: fn(draft.indicators) });
  const updateIndicator = (key: string, patch: Partial<IndicatorConfig>) =>
    setIndicators((list) => list.map((i) => (keyOf(i) === key ? { ...i, ...patch } : i)));
  const removeIndicator = (key: string) =>
    setDraft({
      ...draft,
      indicators: draft.indicators.filter((i) => keyOf(i) !== key),
      rules: draft.rules.filter((r) => r.indicator_id !== key),
    });

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const before = config!.settings.version;
      const saved = await saveTemperatureConfig(company, {
        ...draft,
        // Sem os identificadores temporários da tela.
        indicators: draft.indicators.map(({ _key, ...i }: IndicatorConfig & { _key?: string }) => i),
      });
      reset(saved);
      notify(
        saved.settings.version > before
          ? "Termômetro salvo. As perguntas mudaram: a MAVI vai reler o histórico com o Jev."
          : "Termômetro salvo. As temperaturas são recalculadas em alguns minutos.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const company_ = draft.indicators.filter((i) => !i.product_id);
  const products = data.products.slice().sort((a, b) => a.name.localeCompare(b.name));
  const activeProduct = product || products[0]?.id || "";
  const productName = products.find((p) => p.id === activeProduct)?.name ?? "";
  const ruleOf = (indicator: string) =>
    draft.rules.find((r) => r.product_id === activeProduct && r.indicator_id === indicator);
  function setRule(indicator: string, patch: Partial<ProductRule>) {
    const current = ruleOf(indicator) ?? {
      product_id: activeProduct,
      indicator_id: indicator,
      active: true,
      weight: null,
    };
    const next = { ...current, ...patch };
    const others = draft!.rules.filter(
      (r) => !(r.product_id === activeProduct && r.indicator_id === indicator),
    );
    setDraft({
      ...draft!,
      rules: next.active && next.weight === null ? others : [...others, next],
    });
  }

  return (
    <div className="thermo-settings">
      <section className="panel thermo-settings-intro">
        <div>
          <h2>
            <Thermometer size={18} aria-hidden="true" /> Termômetro do cliente
          </h2>
          <p>
            O Jev (TypeSafe) lê cada reunião gravada e cada dia de conversa nos
            grupos de WhatsApp e responde às perguntas abaixo sobre o cliente. A
            nota de cada indicador vai de 0 (pior) a 100 (melhor); a temperatura
            é a média pelos pesos.
          </p>
        </div>
        <dl className="thermo-settings-stats">
          <div>
            <dt>Quem lê</dt>
            <dd>
              {config.jev ? (
                `${config.jev.provider} · ${config.jev.model}`
              ) : (
                <span className="thermo-missing">
                  <AlertTriangle size={13} aria-hidden="true" /> Falta o Jev: cadastre
                  o modelo ~typesafe/jev-latest num provedor OpenRouter em Provedores
                  e modelos.
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Leituras</dt>
            <dd>
              {count(config.stats.done)} feitas · {count(config.stats.pending)} na fila
              {config.stats.failed ? ` · ${count(config.stats.failed)} com falha` : ""}
            </dd>
          </div>
          <div>
            <dt>Custo em 30 dias</dt>
            <dd>{money(config.cost_30d)}</dd>
          </div>
          <div>
            <dt>Versão das perguntas</dt>
            <dd>{config.settings.version}</dd>
          </div>
        </dl>
      </section>

      <section className="panel thermo-settings-block" aria-label="Escala">
        <header>
          <strong>Escala</strong>
          <small>
            Dê nome e cor a cada faixa da nota. As faixas que avisam mandam um aviso
            aos supervisores das equipes do cliente (sem supervisor, aos
            administradores) quando ele cai para elas.
          </small>
        </header>
        <div className="thermo-scale-preview" aria-hidden="true">
          {s.bands.map((b, i) => (
            <span
              key={i}
              style={{
                flexGrow: (s.bands[i + 1]?.min ?? 100) - b.min,
                background: b.color,
              }}
            >
              {b.name}
            </span>
          ))}
        </div>
        <table className="thermo-bands-table">
          <thead>
            <tr>
              <th>Cor</th>
              <th>Nome</th>
              <th>A partir de</th>
              <th>Avisa</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {s.bands.map((b, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="color"
                    aria-label={`Cor da faixa ${b.name}`}
                    value={b.color}
                    onChange={(e) =>
                      setSettings({ bands: s.bands.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })
                    }
                  />
                </td>
                <td>
                  <Input
                    aria-label="Nome da faixa"
                    value={b.name}
                    maxLength={30}
                    onChange={(e) =>
                      setSettings({ bands: s.bands.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                    }
                  />
                </td>
                <td>
                  <Input
                    type="number"
                    aria-label="A partir da nota"
                    min={0}
                    max={99}
                    value={b.min}
                    disabled={i === 0}
                    onChange={(e) =>
                      setSettings({
                        bands: s.bands.map((x, j) => (j === i ? { ...x, min: Number(e.target.value) } : x)),
                      })
                    }
                  />
                </td>
                <td>
                  <Checkbox
                    aria-label={`A faixa ${b.name} avisa`}
                    checked={b.alert}
                    onCheckedChange={(v) =>
                      setSettings({ bands: s.bands.map((x, j) => (j === i ? { ...x, alert: v === true } : x)) })
                    }
                  />
                </td>
                <td>
                  {s.bands.length > 2 && i > 0 && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remover a faixa ${b.name}`}
                      onClick={() => setSettings({ bands: s.bands.filter((_, j) => j !== i) })}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="thermo-settings-row-actions">
          {s.bands.length < 7 && (
            <Button
              className="btn secondary"
              onClick={() => {
                const last = s.bands[s.bands.length - 1];
                setSettings({
                  bands: [...s.bands, { name: "Nova faixa", min: Math.min(99, Math.round((last.min + 100) / 2)), color: "#8576cf", alert: false }],
                });
              }}
            >
              <Plus size={15} /> Faixa
            </Button>
          )}
          <Button className="btn secondary" onClick={() => setSettings({ bands: DEFAULT_BANDS })}>
            <RotateCcw size={15} /> Voltar à escala inicial
          </Button>
        </div>
      </section>

      <section className="panel thermo-settings-block" aria-label="Cálculo">
        <header>
          <strong>Cálculo</strong>
          <small>
            Cada indicador é a média das leituras da janela, pesada pela fonte, pela
            idade (a leitura perde metade do peso a cada meia-vida), pela confiança
            do Jev e por quanto o material fala do assunto.
          </small>
        </header>
        <div className="thermo-settings-grid">
          <NumberField label="Janela (dias)" min={7} max={365} value={s.window_days} onChange={(v) => setSettings({ window_days: v })} />
          <NumberField label="Meia-vida (dias)" min={1} max={180} value={s.half_life_days} onChange={(v) => setSettings({ half_life_days: v })} />
          <NumberField label="Peso de uma reunião" min={0} max={10} step={0.5} value={s.meeting_weight} onChange={(v) => setSettings({ meeting_weight: v })} />
          <NumberField label="Peso de um dia de WhatsApp" min={0} max={10} step={0.5} value={s.whatsapp_weight} onChange={(v) => setSettings({ whatsapp_weight: v })} />
          <NumberField
            label="Sinal de alerta conta a partir de (%)"
            min={50}
            max={99}
            value={Math.round(s.flag_threshold * 100)}
            onChange={(v) => setSettings({ flag_threshold: v / 100 })}
          />
          <NumberField label="Sinal de alerta vale por (dias)" min={1} max={90} value={s.flag_days} onChange={(v) => setSettings({ flag_days: v })} />
        </div>
        <label className="thermo-check">
          <Checkbox checked={s.alerts} onCheckedChange={(v) => setSettings({ alerts: v === true })} />
          Mandar avisos quando o cliente esfriar ou der um sinal de alerta
        </label>
      </section>

      <section className="panel thermo-settings-block" aria-label="Indicadores da empresa">
        <header>
          <strong>Indicadores da empresa</strong>
          <small>
            Valem para todos os clientes (cada produto pode desligar ou mudar o peso
            abaixo). A descrição e os níveis são o que o Jev lê: escreva do ponto de
            vista do cliente.
          </small>
        </header>
        <IndicatorList
          list={company_}
          onChange={updateIndicator}
          onRemove={removeIndicator}
        />
        <div className="thermo-settings-row-actions">
          <Button className="btn secondary" onClick={() => setIndicators((l) => [...l, blankIndicator("score", null)])}>
            <Plus size={15} /> Indicador de nota
          </Button>
          <Button className="btn secondary" onClick={() => setIndicators((l) => [...l, blankIndicator("flag", null)])}>
            <Plus size={15} /> Sinal de alerta
          </Button>
        </div>
      </section>

      <section className="panel thermo-settings-block" aria-label="Assuntos">
        <header>
          <strong>Assuntos</strong>
          <small>
            Em cada leitura o Jev escolhe o assunto que mais mexe com o humor do
            cliente. Os marcados como rotina não aparecem entre os principais.
          </small>
        </header>
        <label className="thermo-field">
          <span>Pergunta ao Jev</span>
          <Input
            value={s.reason_question}
            maxLength={300}
            onChange={(e) => setSettings({ reason_question: e.target.value })}
          />
        </label>
        <ul className="thermo-reasons-edit">
          {s.reasons.map((r, i) => (
            <li key={r.key || i}>
              <Input
                aria-label="Assunto"
                value={r.label}
                maxLength={120}
                onChange={(e) =>
                  setSettings({ reasons: s.reasons.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })
                }
              />
              <label className="thermo-check">
                <Checkbox
                  checked={r.neutral}
                  onCheckedChange={(v) =>
                    setSettings({ reasons: s.reasons.map((x, j) => (j === i ? { ...x, neutral: v === true } : x)) })
                  }
                />
                Rotina
              </label>
              {s.reasons.length > 2 && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remover o assunto ${r.label}`}
                  onClick={() => setSettings({ reasons: s.reasons.filter((_, j) => j !== i) })}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {s.reasons.length < 20 && (
          <div className="thermo-settings-row-actions">
            <Button
              className="btn secondary"
              onClick={() =>
                setSettings({ reasons: [...s.reasons, { key: "", label: "", neutral: false } as TemperatureReason] })
              }
            >
              <Plus size={15} /> Assunto
            </Button>
          </div>
        )}
      </section>

      <section className="panel thermo-settings-block" aria-label="Por produto">
        <header>
          <strong>Por produto</strong>
          <small>
            Para os clientes de um produto: desligue um indicador da empresa, mude o
            peso dele ou some indicadores próprios. Cliente com vários produtos usa
            a média dos pesos, e o indicador só sai se todos os produtos dele o
            desligarem.
          </small>
        </header>
        {!products.length ? (
          <p className="muted">Cadastre produtos para ajustar o termômetro por produto.</p>
        ) : (
          <>
            <Select aria-label="Produto" value={activeProduct} onValueChange={setProduct}>
              {products.map((p) => (
                <SelectOption key={p.id} value={p.id}>
                  {p.name}
                </SelectOption>
              ))}
            </Select>
            <table className="thermo-rules-table">
              <thead>
                <tr>
                  <th>Indicador da empresa</th>
                  <th>Vale em {productName}</th>
                  <th>Peso em {productName}</th>
                </tr>
              </thead>
              <tbody>
                {company_.filter((i) => i.id).map((i) => {
                  const rule = ruleOf(i.id!);
                  return (
                    <tr key={i.id}>
                      <td>
                        {i.name}
                        <small>{i.kind === "score" ? "nota" : "sinal de alerta"}</small>
                      </td>
                      <td>
                        <Checkbox
                          aria-label={`${i.name} vale em ${productName}`}
                          checked={rule?.active ?? true}
                          onCheckedChange={(v) => setRule(i.id!, { active: v === true })}
                        />
                      </td>
                      <td>
                        {i.kind === "score" && (rule?.active ?? true) && (
                          <Input
                            type="number"
                            aria-label={`Peso de ${i.name} em ${productName}`}
                            min={0}
                            max={10}
                            step={0.5}
                            placeholder={String(i.weight)}
                            value={rule?.weight ?? ""}
                            onChange={(e) =>
                              setRule(i.id!, { weight: e.target.value === "" ? null : Number(e.target.value) })
                            }
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <h4 className="thermo-subhead">Indicadores próprios de {productName}</h4>
            <IndicatorList
              list={draft.indicators.filter((i) => i.product_id === activeProduct)}
              onChange={updateIndicator}
              onRemove={removeIndicator}
              empty={`Nenhum indicador só de ${productName}.`}
            />
            <div className="thermo-settings-row-actions">
              <Button
                className="btn secondary"
                onClick={() => setIndicators((l) => [...l, blankIndicator("score", activeProduct)])}
              >
                <Plus size={15} /> Indicador de nota
              </Button>
              <Button
                className="btn secondary"
                onClick={() => setIndicators((l) => [...l, blankIndicator("flag", activeProduct)])}
              >
                <Plus size={15} /> Sinal de alerta
              </Button>
            </div>
          </>
        )}
      </section>

      <LearningBlock
        company={company}
        indicators={config.indicators}
        reasons={config.settings.reasons}
        notify={notify}
      />

      <div className={`thermo-savebar${dirty ? " dirty" : ""}`}>
        <span>
          <Info size={14} aria-hidden="true" />
          Mudar descrição, níveis, fontes ou assuntos faz a MAVI reler o histórico
          com o Jev (centavos). Pesos, faixas e janela só refazem o cálculo.
        </span>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <Button className="btn secondary" disabled={!dirty || saving} onClick={() => reset(config)}>
            Descartar
          </Button>
          <Button className="btn primary" disabled={!dirty} loading={saving} onClick={save}>
            <Save size={15} /> Salvar
          </Button>
        </div>
      </div>
    </div>
  );
}

/** O nome de uma chave de regra: um indicador, o assunto ou as leituras. */
function keyLabel(key: string, indicators: IndicatorConfig[]) {
  if (key === "motivo") return "Assunto que mais mexe";
  if (key === "leitura") return "Leituras que não contam";
  return indicators.find((i) => i.key === key)?.name ?? key;
}

/** Uma correção do time em uma frase. */
function feedbackText(f: TemperatureFeedback, indicators: IndicatorConfig[], reasons: TemperatureReason[]) {
  const name = keyLabel(f.key ?? "", indicators);
  const reason = (k: unknown) => reasons.find((r) => r.key === k)?.label.split(" (")[0] ?? String(k ?? "nenhum");
  const v = (a: unknown) => {
    const x = a as { v?: number; e?: number } | null;
    if (!x) return "sem nota";
    if (x.e === 0) return "não fala disso";
    return typeof x.v === "number" ? String(Math.round(x.v)) : "?";
  };
  switch (f.kind) {
    case "reason":
      return `Assunto: ${reason(f.before)} → ${reason(f.after)}`;
    case "flag":
      return f.after === true ? `Pôs o sinal "${name}"` : `Tirou o sinal "${name}"`;
    case "score":
      return `${name}: ${v(f.before)} → ${v(f.after)}`;
    case "remove":
      return "Retirou a leitura do cálculo";
    default:
      return (f.before as { auto?: boolean } | null)?.auto
        ? "Devolveu uma leitura que a MAVI tinha retirado"
        : "Devolveu a leitura ao cálculo";
  }
}

/**
 * As regras que a MAVI escreveu com as correções do time (e as dos líderes):
 * vão junto das perguntas ao Jev nas próximas leituras. Quem edita, pausa ou
 * exclui uma regra trava a regra para a MAVI. Salva na hora (fora da barra).
 */
function LearningBlock({
  company,
  indicators,
  reasons,
  notify,
}: {
  company: string;
  indicators: IndicatorConfig[];
  reasons: TemperatureReason[];
  notify: (message: string) => void;
}) {
  const [learning, setLearning] = useState<TemperatureLearning | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; key: string; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const load = () =>
    loadTemperatureLearning(company)
      .then(setLearning)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, [company]); // eslint-disable-line react-hooks/exhaustive-deps

  const keys = [
    ...indicators.filter((i) => i.key && i.active).map((i) => i.key!),
    "motivo",
    "leitura",
  ];
  async function run(id: string, fn: () => Promise<void>, done: string) {
    setBusy(id);
    setError("");
    try {
      await fn();
      await load();
      notify(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const save = (l: { id: string | null; key: string; text: string; status: "active" | "paused" }) =>
    run(
      l.id ?? "new",
      async () => {
        await saveTemperatureLesson(company, l);
        setEditing(null);
      },
      l.id ? "Regra salva. A MAVI não mexe mais nela." : "Regra criada. Entra nas próximas leituras.",
    );
  const groups = keys
    .map((k) => ({ key: k, list: (learning?.lessons ?? []).filter((l) => l.key === k) }))
    .filter((g) => g.list.length || editing?.key === g.key && editing.id === null);
  const author = (l: TemperatureLesson) =>
    l.origin === "person"
      ? `Escrita por ${l.updated_by ?? "um líder"}`
      : l.locked
        ? `Da MAVI, editada por ${l.updated_by ?? "um líder"}`
        : `Da MAVI · ${l.feedback} ${l.feedback === 1 ? "correção" : "correções"}`;

  return (
    <section className="panel thermo-settings-block" aria-label="Aprendizado">
      <header>
        <strong>
          <GraduationCap size={15} aria-hidden="true" /> Aprendizado com as correções
        </strong>
        <small>
          Quando o time corrige uma leitura (assunto, sinal, nota) ou retira uma que
          não conta, a correção vira exemplo para o Jev nas próximas leituras (do
          mesmo cliente primeiro) e a MAVI junta as correções em regras curtas, que
          entram em uso na hora. Edite, pause ou exclua uma regra: a MAVI não mexe
          no que o time mexeu. Regras de "Leituras que não contam" fazem a MAVI
          retirar sozinha as leituras parecidas (o time devolve na aba Retiradas).
        </small>
      </header>
      {!learning ? (
        error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <Loading compact label="Carregando o aprendizado" />
        )
      ) : (
        <>
          <p className="thermo-learning-status">
            {[
              learning.pending > 0
                ? `${learning.pending} ${learning.pending === 1 ? "correção esperando" : "correções esperando"} a MAVI (ela lê em lotes, uns 10 minutos depois da última)`
                : "Nenhuma correção esperando a MAVI",
              learning.learned_at && `regras revistas em ${dateBr(learning.learned_at)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {learning.error && (
            <p className="thermo-missing">
              <AlertTriangle size={13} aria-hidden="true" /> A MAVI não conseguiu escrever as
              regras: {learning.error}
            </p>
          )}
          {!groups.length && !editing && (
            <p className="muted">
              Ainda sem regras. Elas aparecem conforme o time corrige as leituras no
              Termômetro de cada cliente.
            </p>
          )}
          {groups.map((g) => (
            <div key={g.key} className="thermo-lessons">
              <h4 className="thermo-subhead">{keyLabel(g.key, indicators)}</h4>
              <ul>
                {g.list.map((l) =>
                  editing?.id === l.id ? (
                    <li key={l.id}>
                      <LessonEditor
                        value={editing}
                        keys={keys}
                        indicators={indicators}
                        busy={busy === l.id}
                        onChange={setEditing}
                        onCancel={() => setEditing(null)}
                        onSave={() => save({ ...editing, status: l.status })}
                      />
                    </li>
                  ) : (
                    <li key={l.id} className={l.status === "paused" ? "paused" : undefined}>
                      <p>{l.text}</p>
                      <small>
                        {author(l)}
                        {l.status === "paused" && " · pausada"}
                      </small>
                      <span className="thermo-lesson-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Editar a regra"
                          title="Editar"
                          onClick={() => setEditing({ id: l.id, key: l.key, text: l.text })}
                        >
                          <Pencil size={14} />
                        </button>
                        <Button
                          className="icon-btn"
                          aria-label={l.status === "paused" ? "Voltar a usar" : "Pausar"}
                          title={l.status === "paused" ? "Voltar a usar" : "Pausar"}
                          loading={busy === `${l.id}:status`}
                          onClick={() =>
                            run(
                              `${l.id}:status`,
                              () =>
                                saveTemperatureLesson(company, {
                                  ...l,
                                  status: l.status === "paused" ? "active" : "paused",
                                }),
                              l.status === "paused" ? "A regra voltou a valer." : "Regra pausada.",
                            )
                          }
                        >
                          {l.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                        </Button>
                        <Button
                          className="icon-btn"
                          aria-label="Excluir a regra"
                          title="Excluir"
                          loading={busy === `${l.id}:delete`}
                          onClick={() =>
                            run(
                              `${l.id}:delete`,
                              () => deleteTemperatureLesson(company, l.id),
                              "Regra excluída. A MAVI não a escreve de novo.",
                            )
                          }
                        >
                          <Trash2 size={14} />
                        </Button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))}
          {editing?.id === null ? (
            <LessonEditor
              value={editing}
              keys={keys}
              indicators={indicators}
              busy={busy === "new"}
              onChange={setEditing}
              onCancel={() => setEditing(null)}
              onSave={() => save({ ...editing, status: "active" })}
            />
          ) : (
            <div className="thermo-settings-row-actions">
              <Button
                className="btn secondary"
                onClick={() => setEditing({ id: null, key: keys[0] ?? "motivo", text: "" })}
              >
                <Plus size={15} /> Escrever uma regra
              </Button>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {learning.feedback.length > 0 && (
            <div className="thermo-feedback">
              <button
                type="button"
                className="text-btn"
                aria-expanded={showFeedback}
                onClick={() => setShowFeedback((v) => !v)}
              >
                {showFeedback ? "Esconder" : "Ver"} as correções recentes ({learning.feedback.length})
              </button>
              {showFeedback && (
                <ul>
                  {learning.feedback.map((f) => (
                    <li key={f.id}>
                      <span>
                        <strong>{feedbackText(f, indicators, reasons)}</strong>
                        {f.note && <q>{f.note}</q>}
                      </span>
                      <small>
                        {f.client} · {f.type === "meeting" ? "reunião" : "WhatsApp"} de {dateBr(f.day)} ·{" "}
                        {f.by ?? "alguém do time"} em {dateBr(f.at)}
                        {!f.learned && " · esperando a MAVI"}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function LessonEditor({
  value,
  keys,
  indicators,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  value: { id: string | null; key: string; text: string };
  keys: string[];
  indicators: IndicatorConfig[];
  busy: boolean;
  onChange: (v: { id: string | null; key: string; text: string }) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const ok = value.text.trim().length >= 5 && value.text.trim().length <= 400;
  return (
    <div className="thermo-lesson-editor">
      <Select aria-label="Onde a regra vale" value={value.key} onValueChange={(key) => onChange({ ...value, key })}>
        {keys.map((k) => (
          <SelectOption key={k} value={k}>
            {keyLabel(k, indicators)}
          </SelectOption>
        ))}
      </Select>
      <Textarea
        aria-label="Regra"
        value={value.text}
        rows={2}
        maxLength={400}
        autoFocus
        placeholder="Ex.: Brincadeira sobre férias ou folga não é falar em cancelar."
        onChange={(e) => onChange({ ...value, text: e.target.value })}
      />
      <div className="thermo-fix-actions">
        <Button className="btn secondary compact" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button className="btn primary compact" onClick={onSave} loading={busy} disabled={!ok}>
          Salvar regra
        </Button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <label className="thermo-field">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function IndicatorList({
  list,
  onChange,
  onRemove,
  empty,
}: {
  list: IndicatorConfig[];
  onChange: (key: string, patch: Partial<IndicatorConfig>) => void;
  onRemove: (key: string) => void;
  empty?: string;
}) {
  if (!list.length) return empty ? <p className="muted">{empty}</p> : null;
  return (
    <ul className="thermo-indicator-list">
      {list.map((i) => {
        const key = keyOf(i);
        const fresh = !i.id;
        return (
          <li key={key}>
            <details open={fresh}>
              <summary>
                <span
                  className={`thermo-kind ${i.kind}`}
                  style={{ "--band": i.kind === "flag" ? "#c8514f" : "#3f79c4" } as CSSProperties}
                >
                  {i.kind === "score" ? "Nota" : "Sinal"}
                </span>
                <strong>{i.name || (i.kind === "score" ? "Novo indicador" : "Novo sinal de alerta")}</strong>
                {i.kind === "score" && <small>peso {Number(i.weight).toLocaleString("pt-BR")}</small>}
                {i.kind === "flag" && i.alert && <small>avisa</small>}
                {!i.active && <small className="thermo-off">desligado</small>}
              </summary>
              <div className="thermo-indicator-edit">
                <label className="thermo-field">
                  <span>Nome</span>
                  <Input value={i.name} maxLength={80} onChange={(e) => onChange(key, { name: e.target.value })} />
                </label>
                <label className="thermo-field wide">
                  <span>{i.kind === "score" ? "O que o Jev avalia" : "A pergunta de sim ou não"}</span>
                  <Textarea
                    rows={2}
                    maxLength={1000}
                    value={i.description}
                    placeholder={
                      i.kind === "score"
                        ? "Ex.: O quanto o cliente confia nas campanhas de tráfego pago."
                        : "Ex.: O cliente fala em trocar de agência?"
                    }
                    onChange={(e) => onChange(key, { description: e.target.value })}
                  />
                </label>
                {i.kind === "score" && (
                  <>
                    <label className="thermo-field wide">
                      <span>Níveis, do pior para o melhor (um por linha, de 2 a 10)</span>
                      <Textarea
                        rows={Math.max(3, i.levels.length)}
                        value={i.levels.join("\n")}
                        placeholder={"Muito insatisfeito\nNeutro\nMuito satisfeito"}
                        onChange={(e) => onChange(key, { levels: e.target.value.split("\n").slice(0, 10) })}
                      />
                    </label>
                    <label className="thermo-field">
                      <span>Peso na temperatura</span>
                      <Input
                        type="number"
                        min={0}
                        max={10}
                        step={0.5}
                        value={i.weight}
                        onChange={(e) => onChange(key, { weight: Number(e.target.value) })}
                      />
                    </label>
                  </>
                )}
                <fieldset className="thermo-sources">
                  <legend>Lê em</legend>
                  {(["meeting", "whatsapp"] as TemperatureSource[]).map((src) => (
                    <label key={src} className="thermo-check">
                      <Checkbox
                        checked={i.sources.includes(src)}
                        onCheckedChange={(v) =>
                          onChange(key, {
                            sources: v === true ? [...new Set([...i.sources, src])] : i.sources.filter((x) => x !== src),
                          })
                        }
                      />
                      {src === "meeting" ? "Reuniões" : "WhatsApp"}
                    </label>
                  ))}
                </fieldset>
                <div className="thermo-indicator-flags">
                  {i.kind === "flag" && (
                    <label className="thermo-check">
                      <Checkbox checked={i.alert} onCheckedChange={(v) => onChange(key, { alert: v === true })} />
                      Avisar quando aparecer
                    </label>
                  )}
                  <label className="thermo-check">
                    <Checkbox checked={i.active} onCheckedChange={(v) => onChange(key, { active: v === true })} />
                    Ligado
                  </label>
                  <button type="button" className="text-btn danger" onClick={() => onRemove(key)}>
                    <Trash2 size={14} /> Remover
                  </button>
                </div>
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
