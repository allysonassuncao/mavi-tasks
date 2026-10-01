import { useEffect, useState, type CSSProperties } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, History, Plus, Radar, RotateCcw, Save, Square, Trash2 } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import type { Snapshot } from "./types";
import {
  KIND_LABELS,
  SPEAKER_LABELS,
  backfillCost,
  blankTopic,
  cancelBackfill,
  dateBr,
  estimateBackfill,
  loadRadarConfig,
  saveRadarTopics,
  startBackfill,
  type BackfillEstimate,
  type RadarConfig,
  type RadarField,
  type RadarFieldType,
  type RadarSource,
  type RadarSpeaker,
  type RadarStatus,
  type RadarStatusKind,
  type RadarTopic,
} from "./radar";

type Draft = RadarTopic & { _key: string };
let tempId = 0;
const withKey = (t: RadarTopic): Draft => ({ ...structuredClone(t), _key: t.id ?? `novo-${++tempId}` });
const money = (v: number) =>
  Number(v) > 0 && Number(v) < 0.01
    ? "< US$ 0,01"
    : `US$ ${Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (v: number) => Number(v || 0).toLocaleString("pt-BR");
const FIELD_TYPES: Record<RadarFieldType, string> = {
  text: "Texto",
  number: "Número",
  date: "Data",
  choice: "Lista de opções",
};

/**
 * Painel da MAVI › Radar (administradores e gestores): os tópicos que a
 * MAVI procura nas reuniões e nos grupos de WhatsApp — o que conta, o que
 * não conta, quem precisa ter falado, as fontes, os status, a escala de
 * gravidade, os campos extras e os produtos em que cada um vale. As mudanças
 * valem para as próximas leituras.
 */
export function RadarSettings({
  company,
  data,
  notify,
}: {
  company: string;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const [config, setConfig] = useState<RadarConfig | null>(null);
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadRadarConfig(company)
      .then((c) => {
        setConfig(c);
        setDraft(c.topics.map(withKey));
      })
      .catch((e) => setError((e as Error).message));
  }, [company]);

  if (!config || !draft)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading variant="form" />
    );

  const products = data.products.slice().sort((a, b) => a.name.localeCompare(b.name));
  const dirty = JSON.stringify(draft.map(({ _key, ...t }) => t)) !== JSON.stringify(config.topics); // eslint-disable-line @typescript-eslint/no-unused-vars
  const patch = (key: string, p: Partial<RadarTopic>) =>
    setDraft((list) => list!.map((t) => (t._key === key ? { ...t, ...p } : t)));

  async function save() {
    setSaving(true);
    setError("");
    try {
      const next = await saveRadarTopics(
        company,
        draft!.map(({ _key, items, ...t }) => t), // eslint-disable-line @typescript-eslint/no-unused-vars
      );
      setConfig(next);
      setDraft(next.topics.map(withKey));
      notify("Tópicos do Radar salvos. Valem para as próximas leituras.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function add() {
    const t = withKey(blankTopic());
    setDraft([...draft!, t]);
    setOpenKey(t._key);
  }
  function move(key: string, by: number) {
    const list = [...draft!];
    const i = list.findIndex((t) => t._key === key);
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setDraft(list);
  }

  return (
    <div className="thermo-settings radar-settings">
      <section className="panel thermo-settings-intro">
        <div>
          <h2>
            <Radar size={18} aria-hidden="true" /> Radar do cliente
          </h2>
          <p>
            A MAVI lê cada reunião gravada e, a cada busca dos grupos (de hora em hora), as mensagens novas do WhatsApp, e
            anota em cada tópico abaixo o que aparece: um item por assunto, com as vezes em que ele voltou. O
            Jev confere cada item e dá a gravidade.
          </p>
        </div>
        <dl className="thermo-settings-stats">
          <div>
            <dt>Quem lê</dt>
            <dd>
              {config.model
                ? `${config.model.provider} · ${config.model.model}`
                : "Padrão do servidor (Claude). Escolha outro em Quem usa qual modelo."}
            </dd>
          </div>
          <div>
            <dt>Quem confere</dt>
            <dd>
              {config.jev ? (
                `${config.jev.provider} · ${config.jev.model}`
              ) : (
                <span className="thermo-missing">
                  <AlertTriangle size={13} aria-hidden="true" /> Sem o Jev: os itens entram sem conferência e
                  sem gravidade. Cadastre o ~typesafe/jev-latest num provedor OpenRouter.
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
          {config.started_at && (
            <div>
              <dt>Lendo desde</dt>
              <dd>{dateBr(config.started_at)}</dd>
            </div>
          )}
        </dl>
      </section>

      <BackfillBlock
        company={company}
        config={config}
        notify={notify}
        onChanged={() =>
          void loadRadarConfig(company)
            .then(setConfig)
            .catch((e) => setError((e as Error).message))
        }
      />

      <section className="panel thermo-settings-block" aria-label="Tópicos">
        <header>
          <strong>Tópicos</strong>
          <small>
            O que a MAVI procura. Explique com exemplos o que conta e o que não conta: é o que ela lê. Um tópico
            da empresa vale para todos os produtos, menos os que você desligar; um tópico de produto vale só
            para os clientes dele.
          </small>
        </header>
        <ul className="radar-topic-list">
          {draft.map((t, i) => {
            const opened = openKey === t._key;
            return (
              <li key={t._key} className={`radar-topic-edit${t.active ? "" : " off"}`} style={{ "--topic": t.color } as CSSProperties}>
                <div className="radar-topic-row">
                  <button
                    type="button"
                    className="radar-topic-toggle"
                    aria-expanded={opened}
                    onClick={() => setOpenKey(opened ? null : t._key)}
                  >
                    <strong>{t.name || "Tópico sem nome"}</strong>
                    <small>
                      {SPEAKER_LABELS[t.speaker]} ·{" "}
                      {t.sources.map((s) => (s === "meeting" ? "reuniões" : "WhatsApp")).join(" e ")}
                      {t.product_id ? ` · só ${products.find((p) => p.id === t.product_id)?.name ?? "produto"}` : ""}
                      {t.items ? ` · ${count(t.items)} itens` : ""}
                      {!t.active && " · desligado"}
                    </small>
                  </button>
                  <div className="thermo-settings-row-actions">
                    <label className="thermo-check">
                      <Checkbox checked={t.active} onCheckedChange={(v) => patch(t._key, { active: v === true })} />
                      Ligado
                    </label>
                    <button type="button" className="icon-btn" aria-label="Subir" disabled={i === 0} onClick={() => move(t._key, -1)}>
                      <ChevronUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Descer"
                      disabled={i === draft.length - 1}
                      onClick={() => move(t._key, 1)}
                    >
                      <ChevronDown size={15} />
                    </button>
                  </div>
                </div>
                {opened && (
                  <TopicEditor
                    topic={t}
                    products={products}
                    onChange={(p) => patch(t._key, p)}
                    onRemove={
                      t.items
                        ? undefined
                        : () => {
                            setDraft(draft.filter((x) => x._key !== t._key));
                            setOpenKey(null);
                          }
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
        <Button className="btn secondary" onClick={add} disabled={draft.length >= 30}>
          <Plus size={15} aria-hidden="true" /> Novo tópico
        </Button>
      </section>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="radar-settings-save">
        <Button
          className="btn secondary"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(config.topics.map(withKey));
            setError("");
          }}
        >
          <RotateCcw size={15} aria-hidden="true" /> Desfazer
        </Button>
        <Button className="btn primary" onClick={save} loading={saving} disabled={!dirty}>
          <Save size={15} aria-hidden="true" /> Salvar tópicos
        </Button>
      </div>
    </div>
  );
}

function TopicEditor({
  topic: t,
  products,
  onChange,
  onRemove,
}: {
  topic: Draft;
  products: { id: string; name: string }[];
  onChange: (p: Partial<RadarTopic>) => void;
  onRemove?: () => void;
}) {
  const setStatus = (i: number, p: Partial<RadarStatus>) =>
    onChange({ statuses: t.statuses.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const setField = (i: number, p: Partial<RadarField>) =>
    onChange({ fields: t.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const toggleSource = (s: RadarSource, on: boolean) =>
    onChange({ sources: on ? [...new Set([...t.sources, s])] : t.sources.filter((x) => x !== s) });

  return (
    <div className="radar-topic-body">
      <div className="thermo-settings-grid">
        <label className="thermo-field wide">
          <span>Nome</span>
          <Input value={t.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className="thermo-field">
          <span>Cor</span>
          <input type="color" value={t.color} onChange={(e) => onChange({ color: e.target.value })} aria-label="Cor do tópico" />
        </label>
        <label className="thermo-field">
          <span>Vale para</span>
          <Select
            aria-label="Vale para"
            value={t.product_id ?? "__company__"}
            onValueChange={(v) => onChange({ product_id: v === "__company__" ? null : v, off_products: [] })}
          >
            <SelectOption value="__company__">A empresa toda</SelectOption>
            {products.map((p) => (
              <SelectOption key={p.id} value={p.id}>
                {`Só ${p.name}`}
              </SelectOption>
            ))}
          </Select>
        </label>
        <label className="thermo-field wide">
          <span>O que conta (com exemplos)</span>
          <Textarea
            rows={4}
            maxLength={2000}
            value={t.description}
            placeholder='Ex.: pedidos de serviços que o cliente ainda não contrata: "vocês fazem site?", "queria começar SEO".'
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </label>
        <label className="thermo-field wide">
          <span>O que não conta</span>
          <Textarea
            rows={2}
            maxLength={1000}
            value={t.exclude}
            onChange={(e) => onChange({ exclude: e.target.value })}
          />
        </label>
        <label className="thermo-field">
          <span>Quem precisa ter falado</span>
          <Select aria-label="Quem fala" value={t.speaker} onValueChange={(v) => onChange({ speaker: v as RadarSpeaker })}>
            {(Object.keys(SPEAKER_LABELS) as RadarSpeaker[]).map((k) => (
              <SelectOption key={k} value={k}>
                {SPEAKER_LABELS[k]}
              </SelectOption>
            ))}
          </Select>
        </label>
        <fieldset className="thermo-field radar-sources">
          <legend>Onde ler</legend>
          <label className="thermo-check">
            <Checkbox checked={t.sources.includes("meeting")} onCheckedChange={(v) => toggleSource("meeting", v === true)} />
            Reuniões gravadas
          </label>
          <label className="thermo-check">
            <Checkbox checked={t.sources.includes("whatsapp")} onCheckedChange={(v) => toggleSource("whatsapp", v === true)} />
            Grupos de WhatsApp
          </label>
        </fieldset>
        <label className="thermo-check">
          <Checkbox checked={t.has_due} onCheckedChange={(v) => onChange({ has_due: v === true })} />
          Tem prazo (a MAVI anota a data quando é citada)
        </label>
      </div>

      <div className="radar-subblock">
        <label className="thermo-check">
          <Checkbox checked={t.severity} onCheckedChange={(v) => onChange({ severity: v === true })} />
          <strong>Escala de gravidade (o Jev escolhe um dos 4 níveis)</strong>
        </label>
        {t.severity && (
          <div className="radar-levels">
            <label className="thermo-field">
              <span>Nome da escala</span>
              <Input value={t.severity_label} maxLength={30} onChange={(e) => onChange({ severity_label: e.target.value })} />
            </label>
            {t.severity_levels.map((l, i) => (
              <label key={i} className="thermo-field wide">
                <span>Nível {i + 1} {i === 0 ? "(o mais leve)" : i === 3 ? "(o mais sério)" : ""}</span>
                <Input
                  value={l}
                  maxLength={200}
                  onChange={(e) =>
                    onChange({ severity_levels: t.severity_levels.map((x, j) => (j === i ? e.target.value : x)) })
                  }
                />
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="radar-subblock">
        <strong>Status</strong>
        <small className="muted">
          O primeiro status "Aberto" é o de todo item novo. Um status fechado com "reabre" volta para o aberto
          quando o assunto aparece de novo.
        </small>
        <table className="radar-status-table">
          <thead>
            <tr>
              <th>Cor</th>
              <th>Nome</th>
              <th>Tipo</th>
              <th>Reabre</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {t.statuses.map((s, i) => (
              <tr key={s.key ?? i}>
                <td>
                  <input type="color" aria-label={`Cor de ${s.label}`} value={s.color} onChange={(e) => setStatus(i, { color: e.target.value })} />
                </td>
                <td>
                  <Input aria-label="Nome do status" value={s.label} maxLength={30} onChange={(e) => setStatus(i, { label: e.target.value })} />
                </td>
                <td>
                  <Select aria-label="Tipo" value={s.kind} onValueChange={(v) => setStatus(i, { kind: v as RadarStatusKind })}>
                    {(Object.keys(KIND_LABELS) as RadarStatusKind[]).map((k) => (
                      <SelectOption key={k} value={k}>
                        {KIND_LABELS[k]}
                      </SelectOption>
                    ))}
                  </Select>
                </td>
                <td>
                  {s.kind === "closed" ? (
                    <Checkbox aria-label="Reabre" checked={s.reopen} onCheckedChange={(v) => setStatus(i, { reopen: v === true })} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Tirar ${s.label}`}
                    disabled={t.statuses.length <= 2}
                    onClick={() => onChange({ statuses: t.statuses.filter((_, j) => j !== i) })}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button
          className="btn secondary"
          disabled={t.statuses.length >= 8}
          onClick={() => onChange({ statuses: [...t.statuses, { label: "", color: "#6b52b3", kind: "progress", reopen: false }] })}
        >
          <Plus size={14} aria-hidden="true" /> Status
        </Button>
      </div>

      <div className="radar-subblock">
        <strong>Campos extras</strong>
        <small className="muted">A MAVI preenche quando o material diz; o gestor pode corrigir no item.</small>
        {t.fields.map((f, i) => (
          <div key={f.key ?? i} className="radar-field-row">
            <Input aria-label="Nome do campo" placeholder="Nome" value={f.label} maxLength={40} onChange={(e) => setField(i, { label: e.target.value })} />
            <Select aria-label="Tipo do campo" value={f.type} onValueChange={(v) => setField(i, { type: v as RadarFieldType })}>
              {(Object.keys(FIELD_TYPES) as RadarFieldType[]).map((k) => (
                <SelectOption key={k} value={k}>
                  {FIELD_TYPES[k]}
                </SelectOption>
              ))}
            </Select>
            {f.type === "choice" ? (
              <Input
                aria-label="Opções"
                placeholder="Opções separadas por vírgula"
                value={f.options.join(", ")}
                onChange={(e) => setField(i, { options: e.target.value.split(",").map((o) => o.trimStart()) })}
                onBlur={() => setField(i, { options: f.options.map((o) => o.trim()).filter(Boolean) })}
              />
            ) : (
              <Input
                aria-label="Dica para a MAVI"
                placeholder="Dica para a MAVI (opcional)"
                value={f.hint ?? ""}
                maxLength={200}
                onChange={(e) => setField(i, { hint: e.target.value })}
              />
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label={`Tirar ${f.label || "campo"}`}
              onClick={() => onChange({ fields: t.fields.filter((_, j) => j !== i) })}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <Button
          className="btn secondary"
          disabled={t.fields.length >= 8}
          onClick={() => onChange({ fields: [...t.fields, { label: "", type: "text", options: [] }] })}
        >
          <Plus size={14} aria-hidden="true" /> Campo
        </Button>
      </div>

      {!t.product_id && products.length > 0 && (
        <div className="radar-subblock">
          <strong>Desligar em alguns produtos</strong>
          <div className="radar-off-products">
            {products.map((p) => (
              <label key={p.id} className="thermo-check">
                <Checkbox
                  checked={t.off_products.includes(p.id)}
                  onCheckedChange={(v) =>
                    onChange({
                      off_products: v === true ? [...t.off_products, p.id] : t.off_products.filter((x) => x !== p.id),
                    })
                  }
                />
                {`Desligado em ${p.name}`}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="radar-topic-footer">
        {onRemove ? (
          <button type="button" className="text-btn danger" onClick={onRemove}>
            <Trash2 size={14} aria-hidden="true" /> Excluir tópico
          </button>
        ) : (
          <small className="muted">Este tópico já tem itens: para parar de acompanhar, desligue-o.</small>
        )}
      </div>
    </div>
  );
}

const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Painel da MAVI › Radar › Histórico: as reuniões e os dias de grupo de antes
 * de o Radar ligar. Mostra quantos são e o custo estimado (pelo custo médio
 * das leituras já feitas) antes de começar; a leitura vai depois das do dia a
 * dia e pode ser parada.
 */
function BackfillBlock({
  company,
  config,
  notify,
  onChanged,
}: {
  company: string;
  config: RadarConfig;
  notify: (message: string) => void;
  onChanged: () => void;
}) {
  const start = config.started_at ? config.started_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const [preset, setPreset] = useState("90");
  const [custom, setCustom] = useState(addDays(start, -90));
  const [estimate, setEstimate] = useState<BackfillEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const b = config.backfill;
  const from =
    preset === "custom" ? custom : preset === "all" ? (estimate?.oldest ?? addDays(start, -3650)) : addDays(start, -Number(preset));
  const cost = estimate ? backfillCost(estimate) : null;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel thermo-settings-block radar-backfill" aria-label="Histórico">
      <header>
        <strong>
          <History size={15} aria-hidden="true" /> Histórico
        </strong>
        <small>
          O Radar lê o que acontece desde {dateBr(config.started_at)}. As reuniões gravadas e os dias de WhatsApp de
          antes podem ser lidos também: a MAVI lê um por um, depois das leituras do dia a dia, e o histórico não manda
          avisos.
        </small>
      </header>
      {b && b.pending > 0 ? (
        <div className="radar-backfill-status">
          <p>
            <strong>Lendo o histórico desde {dateBr(b.from)}</strong>
            {b.by_name && ` (pedido por ${b.by_name})`}: {b.done} lidas, {b.pending} na fila
            {b.failed ? `, ${b.failed} com falha` : ""} · custo até agora {money(b.cost)}.
          </p>
          <progress max={b.done + b.pending} value={b.done} />
          <Button
            className="btn secondary"
            loading={busy}
            onClick={() =>
              run(async () => {
                const n = await cancelBackfill(company);
                notify(`Leitura do histórico parada: ${n} ${n === 1 ? "saiu" : "saíram"} da fila.`);
                onChanged();
              })
            }
          >
            <Square size={14} aria-hidden="true" /> Parar
          </Button>
        </div>
      ) : (
        <>
          {b?.from && (
            <p className="muted radar-report-note">
              Histórico desde {dateBr(b.from)} lido ({b.done} leituras, {money(b.cost)}).
            </p>
          )}
          <div className="radar-backfill-form">
            <label className="thermo-field">
              <span>Ler desde</span>
              <Select
                aria-label="Ler desde"
                value={preset}
                onValueChange={(v) => {
                  setPreset(v);
                  setEstimate(null);
                }}
              >
                <SelectOption value="30">30 dias antes</SelectOption>
                <SelectOption value="90">90 dias antes</SelectOption>
                <SelectOption value="180">6 meses antes</SelectOption>
                <SelectOption value="365">1 ano antes</SelectOption>
                <SelectOption value="all">Tudo o que existe</SelectOption>
                <SelectOption value="custom">Escolher a data</SelectOption>
              </Select>
            </label>
            {preset === "custom" && (
              <label className="thermo-field">
                <span>Data</span>
                <Input
                  type="date"
                  value={custom}
                  max={addDays(start, -1)}
                  onChange={(e) => {
                    setCustom(e.target.value);
                    setEstimate(null);
                  }}
                />
              </label>
            )}
            <Button
              className="btn secondary"
              loading={busy && !estimate}
              onClick={() => run(async () => setEstimate(await estimateBackfill(company, preset === "all" ? "1900-01-01" : from)))}
            >
              Calcular o custo
            </Button>
          </div>
          {estimate && cost && (
            <div className="radar-backfill-estimate">
              <p>
                <strong>
                  {estimate.meetings} {estimate.meetings === 1 ? "reunião" : "reuniões"} e {estimate.whatsapp_days}{" "}
                  {estimate.whatsapp_days === 1 ? "dia" : "dias"} de grupo
                </strong>{" "}
                entre {dateBr(preset === "all" ? estimate.oldest : estimate.from)} e {dateBr(estimate.until)}.
              </p>
              {cost.signals > 0 ? (
                <p>
                  Custo estimado: <strong>{money(cost.low)} a {money(cost.high)}</strong>{" "}
                  <small className="muted">
                    (
                    {cost.measured
                      ? `pelo custo médio das ${estimate.samples} leituras já feitas`
                      : "pelo tamanho do texto e o preço do modelo; fica mais preciso depois das primeiras leituras"}
                    , com os temas e a conferência)
                  </small>
                </p>
              ) : (
                <p className="muted">Não há nada para ler nesse período.</p>
              )}
              {cost.signals > 0 && (
                <Button
                  className="btn primary"
                  loading={busy}
                  onClick={() =>
                    run(async () => {
                      const n = await startBackfill(
                        company,
                        preset === "all" ? (estimate.oldest ?? from) : from,
                      );
                      notify(`${n} ${n === 1 ? "leitura entrou" : "leituras entraram"} na fila do histórico.`);
                      setEstimate(null);
                      onChanged();
                    })
                  }
                >
                  <History size={15} aria-hidden="true" /> Ler o histórico
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
