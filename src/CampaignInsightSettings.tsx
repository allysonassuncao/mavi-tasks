import { useEffect, useState } from "react";
import { AlertTriangle, Check, GraduationCap, Lightbulb, Pause, Pencil, Play, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import type { Snapshot } from "./types";
import { supabaseCampaigns } from "./campaigns";
import {
  DEFAULT_SETTINGS,
  KIND_LABELS,
  WEEKDAYS,
  deleteInsightRule,
  loadInsightLessons,
  loadInsightSettings,
  saveInsightLesson,
  setInsightLesson,
  money,
  saveInsightRule,
  saveInsightSettings,
  scheduleText,
  type InsightFrequency,
  type InsightKind,
  type InsightLesson,
  type InsightRule,
  type InsightSettings,
  type InsightSettingsView,
} from "./campaign-insights";
import "./campaign-insights.css";

/**
 * Painel da MAVI › Campanhas (administradores e gestores): liga os insights
 * da MAVI, a frequência padrão e os ajustes por cliente ou campanha, onde os
 * insights aparecem, quem recebe na caixa de entrada, os valores com ou sem
 * M e os tetos de custo. Os modelos ficam em Quem usa qual modelo
 * (funcionalidades "Insights da MAVI").
 */

type Schedule = Pick<InsightSettings, "frequency" | "weekdays" | "every_days" | "hour">;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const INTERVALS: [number, string][] = [
  [0, "Sem intervalo"],
  [30, "30 minutos"],
  [60, "1 hora"],
  [120, "2 horas"],
  [240, "4 horas"],
  [480, "8 horas"],
  [720, "12 horas"],
  [1440, "24 horas"],
];

/** A frequência (padrão da empresa e ajustes). */
function ScheduleFields({
  value,
  onChange,
  idPrefix,
}: {
  value: Schedule;
  onChange: (v: Schedule) => void;
  idPrefix: string;
}) {
  return (
    <div className="cins-schedule">
      <label>
        <span>Frequência</span>
        <Select
          value={value.frequency}
          onValueChange={(f) => onChange({ ...value, frequency: f as InsightFrequency })}
          aria-label="Frequência"
        >
          <SelectOption value="weekdays">Nos dias da semana escolhidos</SelectOption>
          <SelectOption value="daily">Todo dia</SelectOption>
          <SelectOption value="every">A cada N dias</SelectOption>
        </Select>
      </label>
      {value.frequency === "weekdays" && (
        <fieldset className="cins-weekdays">
          <legend>Dias</legend>
          {WEEKDAYS.map((d, i) => {
            const on = value.weekdays.includes(i);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                className={on ? "on" : ""}
                onClick={() =>
                  onChange({
                    ...value,
                    weekdays: on ? value.weekdays.filter((x) => x !== i) : [...value.weekdays, i].sort(),
                  })
                }
              >
                {d}
              </button>
            );
          })}
        </fieldset>
      )}
      {value.frequency === "every" && (
        <label>
          <span>A cada (dias)</span>
          <Input
            id={`${idPrefix}-every`}
            type="number"
            min={2}
            max={30}
            value={value.every_days}
            onChange={(e) => onChange({ ...value, every_days: Math.min(Math.max(Number(e.target.value) || 2, 2), 30) })}
          />
        </label>
      )}
      <label>
        <span>A partir das</span>
        <Select
          value={String(value.hour)}
          onValueChange={(h) => onChange({ ...value, hour: Number(h) })}
          aria-label="A partir das"
        >
          {HOURS.map((h) => (
            <SelectOption key={h} value={String(h)}>
              {`${h}h`}
            </SelectOption>
          ))}
        </Select>
      </label>
    </div>
  );
}

export function CampaignInsightSettings({
  company,
  data,
  notify,
}: {
  company: string;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const [config, setConfig] = useState<InsightSettingsView | null>(null);
  const [draft, setDraft] = useState<InsightSettings | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [capText, setCapText] = useState("");
  useEffect(() => {
    loadInsightSettings(company)
      .then((c) => {
        setConfig(c);
        setDraft({ ...DEFAULT_SETTINGS, ...c.settings });
        setCapText(c.settings.monthly_cap_usd === null ? "" : String(c.settings.monthly_cap_usd));
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
  const set = (patch: Partial<InsightSettings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...DEFAULT_SETTINGS, ...config.settings });
  const save = async () => {
    if (draft.frequency === "weekdays" && !draft.weekdays.length) {
      setError("Escolha ao menos um dia da semana.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const c = await saveInsightSettings(company, draft);
      setConfig(c);
      setDraft({ ...DEFAULT_SETTINGS, ...c.settings });
      setCapText(c.settings.monthly_cap_usd === null ? "" : String(c.settings.monthly_cap_usd));
      notify("Configuração dos insights salva.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const cap = config.settings.monthly_cap_usd;

  return (
    <div className="thermo-settings cins-settings">
      <section className="panel thermo-settings-intro cins-intro">
        <div>
          <h2>
            <Lightbulb size={18} aria-hidden="true" /> Insights da MAVI nas campanhas
          </h2>
          <p>
            De tempos em tempos a MAVI analisa cada campanha ativa do Meta e do Google: lê a plataforma (ciclo, 7, 15
            e 30 dias e desde a última análise), cruza com o MakeCRM por UTM e com o contexto do cliente, e aponta
            destaques, oportunidades, problemas e correções de rastreamento. Todo insight traz as evidências em
            números, conferidas pelo sistema (e pelo Jev, quando cadastrado). Os modelos ficam em{" "}
            <a href="#regras">Quem usa qual modelo</a>.
          </p>
        </div>
        <dl className="thermo-settings-stats">
          <div>
            <dt>Campanhas que podem ser analisadas</dt>
            <dd>{config.campaigns.toLocaleString("pt-BR")} ativas (Meta e Google)</dd>
          </div>
          <div>
            <dt>Análises no mês</dt>
            <dd>{config.runs_month.toLocaleString("pt-BR")}</dd>
          </div>
          <div>
            <dt>Gasto no mês</dt>
            <dd>
              {money(config.spent_month)}
              {cap !== null ? ` de ${money(cap)}` : " (sem teto)"}
            </dd>
          </div>
          {config.capped && (
            <div>
              <dt>Situação</dt>
              <dd className="thermo-missing">
                <AlertTriangle size={13} aria-hidden="true" /> Teto do mês atingido: as análises voltam quando o mês
                virar ou o teto subir.
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="panel cins-block">
        <h3>Análises</h3>
        <label className="cins-check">
          <Checkbox checked={draft.enabled} onCheckedChange={(v) => set({ enabled: v === true })} />
          <span>
            <strong>Ligar os insights da MAVI</strong>
            <small>Desligado, nada é analisado e o painel, a aba e o selo não aparecem.</small>
          </span>
        </label>
        <p className="cins-help">Frequência padrão da empresa (um ajuste do cliente ou da campanha vence):</p>
        <ScheduleFields
          idPrefix="cins-company"
          value={draft}
          onChange={(v) => set(v)}
        />
        <p className="cins-help">
          {scheduleText({ ...draft, enabled: draft.enabled })}. A MAVI lê os dias fechados (até ontem); cada campanha
          é analisada no máximo uma vez por dia pelo agendamento.
        </p>
      </section>

      <section className="panel cins-block">
        <h3>Onde aparece</h3>
        <label className="cins-check">
          <Checkbox checked={draft.show_panel} onCheckedChange={(v) => set({ show_panel: v === true })} />
          <span>
            <strong>Painel ao lado da campanha</strong>
            <small>Os insights abertos da última análise, em qualquer aba do detalhe (cada pessoa pode recolher).</small>
          </span>
        </label>
        <label className="cins-check">
          <Checkbox checked={draft.show_tab} onCheckedChange={(v) => set({ show_tab: v === true })} />
          <span>
            <strong>Aba "Insights" na campanha</strong>
            <small>Todos os insights e o histórico das análises, com quem pediu, o modelo e o custo.</small>
          </span>
        </label>
        <label className="cins-check">
          <Checkbox checked={draft.show_badge} onCheckedChange={(v) => set({ show_badge: v === true })} />
          <span>
            <strong>Selo na lista de Campanhas</strong>
            <small>Uma coluna com quantos insights cada campanha tem abertos (e quantos de prioridade alta).</small>
          </span>
        </label>
        <label className="cins-check">
          <Checkbox checked={draft.mavi_context} onCheckedChange={(v) => set({ mavi_context: v === true })} />
          <span>
            <strong>Na conversa com a MAVI sobre a campanha</strong>
            <small>
              A MAVI conhece os insights abertos, os aplicados (com o efeito) e os descartados quando alguém pergunta
              sobre a campanha.
            </small>
          </span>
        </label>
      </section>

      <section className="panel cins-block">
        <h3>Caixa de entrada e push</h3>
        <label className="cins-check">
          <Checkbox checked={draft.notify_inbox} onCheckedChange={(v) => set({ notify_inbox: v === true })} />
          <span>
            <strong>Avisar quando sair insight novo</strong>
            <small>
              Um aviso por análise. Quem pediu "Analisar agora" é sempre avisado. Cada pessoa pode desligar em
              Preferências de notificação.
            </small>
          </span>
        </label>
        <div className="cins-row" aria-disabled={!draft.notify_inbox}>
          <label>
            <span>Prioridade mínima</span>
            <Select
              value={draft.notify_min_priority}
              onValueChange={(v) => set({ notify_min_priority: v as InsightSettings["notify_min_priority"] })}
              disabled={!draft.notify_inbox}
              aria-label="Prioridade mínima"
            >
              <SelectOption value="high">Só os de "Fazer hoje"</SelectOption>
              <SelectOption value="medium">"Fazer hoje" e "Nesta semana"</SelectOption>
              <SelectOption value="low">Todos</SelectOption>
            </Select>
          </label>
          <label>
            <span>Quem recebe</span>
            <Select
              value={draft.notify_who}
              onValueChange={(v) => set({ notify_who: v as InsightSettings["notify_who"] })}
              disabled={!draft.notify_inbox}
              aria-label="Quem recebe"
            >
              <SelectOption value="owners">Os responsáveis pela campanha</SelectOption>
              <SelectOption value="team">As pessoas das equipes do cliente</SelectOption>
              <SelectOption value="team_leaders">As equipes do cliente e os administradores e gestores</SelectOption>
            </Select>
            <small>
              Os responsáveis são escolhidos na aba Insights de cada campanha e sempre recebem. Campanha sem responsável:
              avisa as equipes do cliente.
            </small>
          </label>
        </div>
      </section>

      <section className="panel cins-block">
        <h3>Menos e melhor</h3>
        <p className="cins-help">
          A MAVI traz só os insights mais importantes de cada análise, em linguagem simples, com o primeiro marcado como
          "Comece por aqui". E só conclui que algo vai bem ou mal com número suficiente: abaixo da amostra mínima, a ideia
          fica de fora (o rastreamento e as detecções automáticas não dependem dela).
        </p>
        <div className="cins-row">
          <label>
            <span>Insights por análise</span>
            <Select
              value={String(draft.max_insights)}
              onValueChange={(v) => set({ max_insights: Number(v) })}
              aria-label="Insights por análise"
            >
              {[3, 4, 5, 6].map((n) => (
                <SelectOption key={n} value={String(n)}>
                  {`Até ${n}`}
                </SelectOption>
              ))}
            </Select>
            <small>Os de prioridade maior primeiro; os demais ficam de fora (a nota da análise diz quantos).</small>
          </label>
          <label>
            <span>Amostra mínima</span>
            <Select
              value={String(draft.min_results)}
              onValueChange={(v) => set({ min_results: Number(v) })}
              aria-label="Amostra mínima"
            >
              {[0, 5, 10, 20, 30, 50].map((n) => (
                <SelectOption key={n} value={String(n)}>
                  {n === 0 ? "Sem mínimo" : `${n} resultados`}
                </SelectOption>
              ))}
            </Select>
            <small>
              No item e no período citados. Também vale metade disso em oportunidades no CRM, ou o investimento de 2
              resultados da meta (para apontar o que gasta sem trazer nada).
            </small>
          </label>
        </div>
      </section>

      <section className="panel cins-block">
        <h3>Insights sem uso</h3>
        <p className="cins-help">
          Um insight que fica aberto sem que ninguém o aplique, adie, descarte, avalie (👍/👎) ou transforme em tarefa
          expira e sai da campanha. No histórico das análises fica só a contagem, e a MAVI não traz o mesmo assunto de
          volta por 30 dias, a não ser que os números piorem bem.
        </p>
        <div className="cins-row">
          <label>
            <span>Expira depois de</span>
            <Select
              value={String(draft.expire_days)}
              onValueChange={(v) => set({ expire_days: Number(v) })}
              aria-label="Prazo para o insight sem uso expirar"
            >
              {[7, 10, 15, 21, 30, 45, 60, 0].map((n) => (
                <SelectOption key={n} value={String(n)}>
                  {n === 0 ? "Nunca expira" : `${n} dias abertos`}
                </SelectOption>
              ))}
            </Select>
            <small>Contados da análise que o trouxe (ou de quando voltou a ficar aberto).</small>
          </label>
        </div>
      </section>

      <section className="panel cins-block">
        <h3>Valores em R$</h3>
        <div className="cins-radio" role="radiogroup" aria-label="Valores em R$">
          {(
            [
              ["net", "Sem M", "O investimento real na plataforma (como no Gerenciador e na aba Plataforma)."],
              ["gross", "Com M", "O investimento multiplicado pelo M do ciclo, como o cliente vê."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className={draft.money_basis === value ? "on" : ""}>
              <input
                type="radio"
                name="cins-basis"
                checked={draft.money_basis === value}
                onChange={() => set({ money_basis: value })}
              />
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="cins-help">Todo insight mostra, discretamente, se os valores estão com ou sem M.</p>
      </section>

      <section className="panel cins-block">
        <h3>Custo</h3>
        <div className="cins-row">
          <label>
            <span>Teto do mês (US$)</span>
            <Input
              type="number"
              min={0}
              step="1"
              placeholder="Sem teto"
              value={capText}
              onChange={(e) => {
                setCapText(e.target.value);
                set({ monthly_cap_usd: e.target.value === "" ? null : Math.max(Number(e.target.value) || 0, 0) });
              }}
            />
            <small>Vazio: sem teto. No teto, as análises param até o mês virar (os líderes são avisados).</small>
          </label>
          <label>
            <span>Teto por análise (US$)</span>
            <Input
              type="number"
              min={0.05}
              max={20}
              step="0.05"
              value={draft.run_cap_usd}
              onChange={(e) => set({ run_cap_usd: Math.min(Math.max(Number(e.target.value) || 0.05, 0.05), 20) })}
            />
            <small>A MAVI enxuga o material para caber; se nem o mínimo couber, ficam só as detecções automáticas.</small>
          </label>
          <label>
            <span>Intervalo do "Analisar agora"</span>
            <Select
              value={String(draft.min_interval_minutes)}
              onValueChange={(v) => set({ min_interval_minutes: Number(v) })}
              aria-label="Intervalo mínimo entre análises"
            >
              {INTERVALS.map(([m, label]) => (
                <SelectOption key={m} value={String(m)}>
                  {label}
                </SelectOption>
              ))}
            </Select>
            <small>Tempo mínimo desde a última análise da campanha para pedir outra.</small>
          </label>
        </div>
      </section>

      <section className="panel cins-block">
        <h3>Criativos</h3>
        <p className="cins-help">
          A MAVI enxerga os anúncios que pesam na campanha para explicar o porquê do desempenho (a promessa, o
          gancho, a oferta). Cada criativo é lido uma vez — pela imagem ou pelo vídeo — e reaproveitado nas
          próximas análises e nas outras campanhas que usam o mesmo criativo. Os modelos ficam em{" "}
          <a href="#regras">Quem usa qual modelo</a> (leitura das imagens e transcrição dos vídeos).
        </p>
        <label className="cins-check">
          <Checkbox checked={draft.creative_images} onCheckedChange={(v) => set({ creative_images: v === true })} />
          <span>
            <strong>Ler as imagens dos anúncios</strong>
            <small>A imagem com o texto do anúncio, pelo modelo de visão.</small>
          </span>
        </label>
        <label className="cins-check">
          <Checkbox checked={draft.creative_videos} onCheckedChange={(v) => set({ creative_videos: v === true })} />
          <span>
            <strong>Ler os vídeos</strong>
            <small>
              A capa e a transcrição do áudio (vídeos de até 24 MB; sem acesso ao arquivo, só a capa). No Google,
              por enquanto, só os anúncios com imagem.
            </small>
          </span>
        </label>
        <div className="cins-row">
          <label>
            <span>Criativos novos por análise</span>
            <Select
              value={String(draft.creative_new_max)}
              onValueChange={(v) => set({ creative_new_max: Number(v) })}
              aria-label="Criativos novos por análise"
            >
              {[0, 2, 4, 6, 8, 12].map((n) => (
                <SelectOption key={n} value={String(n)}>
                  {n === 0 ? "Nenhum (só os já lidos)" : `Até ${n}`}
                </SelectOption>
              ))}
            </Select>
            <small>Os de maior investimento primeiro; o resto fica para a próxima análise. Até 40% do teto por análise.</small>
          </label>
        </div>
      </section>

      <section className="panel cins-block">
        <h3>Sem leitura à toa e limites das plataformas</h3>
        <p className="cins-help">
          A leitura é enxuta (uma chamada por nível no Meta e uma consulta por visão no Google, com todas as
          janelas), uma campanha por vez em cada conta de anúncios. Quando a plataforma avisa que a cota está perto
          do fim (75%) ou recusa por limite, a conta fica pausada até a hora indicada e a análise volta para a fila
          sem contar como falha. Campanha sem investimento desde a última análise é pulada sem chamar a API nem a
          MAVI.
        </p>
        <div className="cins-row">
          <label>
            <span>Dias novos com investimento para reler</span>
            <Select
              value={String(draft.min_new_days)}
              onValueChange={(v) => set({ min_new_days: Number(v) })}
              aria-label="Dias novos com investimento para reler"
            >
              <SelectOption value="0">Sempre que agendada</SelectOption>
              {[1, 2, 3, 4, 5, 7].map((n) => (
                <SelectOption key={n} value={String(n)}>
                  {`Ao menos ${n} ${n === 1 ? "dia" : "dias"}`}
                </SelectOption>
              ))}
            </Select>
            <small>
              No agendamento, com menos dias novos que isso a MAVI não relê (os insights abertos continuam valendo).
              O "Analisar agora" sempre lê.
            </small>
          </label>
          <label>
            <span>Operações do Google por dia (MAVI)</span>
            <Input
              type="number"
              min={0}
              step="10"
              value={draft.google_daily_ops}
              onChange={(e) => set({ google_daily_ops: Math.max(Math.round(Number(e.target.value) || 0), 0) })}
            />
            <small>
              Usadas nas últimas 24 h: {config.google_ops_24h.toLocaleString("pt-BR")}. Cada análise usa ~7 por
              conta. O developer token é o mesmo da sincronização e da aba Plataforma (Explorer: 2.880 por dia no
              total).
            </small>
          </label>
        </div>
        {config.paused.length > 0 && (
          <ul className="cins-paused">
            {config.paused.map((p) => (
              <li key={`${p.platform}:${p.account_id}`}>
                <AlertTriangle size={13} aria-hidden="true" />
                <span>
                  <strong>
                    {p.platform === "meta" ? "Meta" : "Google"}
                    {p.account_id === "*" ? " (todas as contas)" : ` · conta ${p.account_id}`}
                  </strong>{" "}
                  pausado até{" "}
                  {new Date(p.until).toLocaleTimeString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: config.timezone || undefined,
                  })}
                  {p.reason ? ` — ${p.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
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
            setDraft({ ...DEFAULT_SETTINGS, ...config.settings });
            setCapText(config.settings.monthly_cap_usd === null ? "" : String(config.settings.monthly_cap_usd));
            setError("");
          }}
        >
          <RotateCcw size={15} aria-hidden="true" /> Desfazer
        </Button>
        <Button className="btn primary" onClick={() => void save()} loading={saving} disabled={!dirty}>
          <Save size={15} aria-hidden="true" /> Salvar
        </Button>
      </div>

      <RulesBlock company={company} data={data} config={config} onChange={setConfig} notify={notify} />
      <LessonsBlock company={company} data={data} notify={notify} />
    </div>
  );
}

const LESSON_STATUS: Record<InsightLesson["status"], string> = {
  active: "Em uso",
  candidate: "Aguardando confirmação",
  paused: "Pausado",
  dismissed: "Excluído",
};
type LessonDraft = {
  id?: string;
  scope: InsightLesson["scope"];
  client_id: string;
  product_id: string;
  kind: "" | InsightKind;
  text: string;
};

/**
 * Os aprendizados do time: a MAVI tira dos 👍/👎 e dos descartes; valem com
 * 2 pessoas ou 1 líder. Os líderes conferem, pausam, editam, excluem ou
 * escrevem os seus (que valem na hora).
 */
function LessonsBlock({ company, data, notify }: { company: string; data: Snapshot; notify: (m: string) => void }) {
  const [view, setView] = useState<Awaited<ReturnType<typeof loadInsightLessons>> | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<LessonDraft | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadInsightLessons(company)
      .then(setView)
      .catch((e) => setError((e as Error).message));
  }, [company]);
  const act = async (job: () => Promise<Awaited<ReturnType<typeof loadInsightLessons>>>, done: string) => {
    setBusy(true);
    try {
      setView(await job());
      notify(done);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const clients = [...data.clients].filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const products = [...data.products].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const where = (l: InsightLesson) =>
    l.scope === "company" ? "Toda a agência" : l.scope === "client" ? `Cliente ${l.client_name ?? ""}` : `Produto ${l.product_name ?? ""}`;
  return (
    <section className="panel cins-block">
      <h3>
        <GraduationCap size={16} aria-hidden="true" /> Aprendizados do time
      </h3>
      <p className="cins-help">
        Os 👍/👎 e os descartes (com motivo) dos insights viram regras que as próximas análises seguem. A MAVI propõe;
        o aprendizado vale com 2 pessoas avaliando no mesmo sentido ou com 1 administrador ou gestor. Os escritos aqui
        valem na hora.
        {view ? ` Avaliações nos últimos 30 dias: ${view.feedback_30d}${view.pending ? ` (${view.pending} esperando a MAVI ler)` : ""}.` : ""}
      </p>
      {error && <p className="form-error">{error}</p>}
      {!view && !error && <Loading variant="list" />}
      {view && view.lessons.length > 0 && (
        <ul className="cins-rules cins-lessons">
          {view.lessons.map((l) => (
            <li key={l.id} className={`status-${l.status}`}>
              <div>
                <strong>{l.text}</strong>
                <small>
                  {where(l)}
                  {l.kind ? ` · ${KIND_LABELS[l.kind]}` : ""} · {LESSON_STATUS[l.status]}
                  {l.origin === "person" ? " · escrito por líder" : ` · ${l.people} ${l.people === 1 ? "pessoa" : "pessoas"}${l.has_leader ? " (com líder)" : ""}`}
                  {!l.reviewed_at && l.origin === "mavi" ? " · novo" : ""}
                </small>
              </div>
              {!l.reviewed_at && (
                <button type="button" className="icon-btn" title="Conferido" aria-label="Marcar como conferido" disabled={busy}
                  onClick={() => void act(() => setInsightLesson(company, l.id, "review"), "Aprendizado conferido.")}>
                  <Check size={15} />
                </button>
              )}
              {l.status === "paused" ? (
                <button type="button" className="icon-btn" title="Voltar a usar" aria-label="Voltar a usar" disabled={busy}
                  onClick={() => void act(() => setInsightLesson(company, l.id, "activate"), "Aprendizado em uso.")}>
                  <Play size={15} />
                </button>
              ) : (
                <button type="button" className="icon-btn" title="Pausar" aria-label="Pausar" disabled={busy}
                  onClick={() => void act(() => setInsightLesson(company, l.id, "pause"), "Aprendizado pausado.")}>
                  <Pause size={15} />
                </button>
              )}
              <button type="button" className="icon-btn" title="Editar" aria-label="Editar" disabled={busy}
                onClick={() =>
                  setDraft({ id: l.id, scope: l.scope, client_id: l.client_id ?? "", product_id: l.product_id ?? "", kind: l.kind ?? "", text: l.text })
                }>
                <Pencil size={15} />
              </button>
              <button type="button" className="icon-btn" title="Excluir" aria-label="Excluir" disabled={busy}
                onClick={() => void act(() => setInsightLesson(company, l.id, "dismiss"), "Aprendizado excluído: a MAVI não volta a ele.")}>
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {view && !view.lessons.length && !draft && (
        <p className="cins-help">Nenhum aprendizado ainda. Eles aparecem conforme o time avalia e descarta insights.</p>
      )}
      {draft ? (
        <div className="cins-rule-editor">
          <div className="cins-row">
            <label>
              <span>Vale para</span>
              <Select value={draft.scope} onValueChange={(v) => setDraft({ ...draft, scope: v as LessonDraft["scope"] })} aria-label="Vale para">
                <SelectOption value="company">Toda a agência</SelectOption>
                <SelectOption value="client">Um cliente</SelectOption>
                <SelectOption value="product">Um produto</SelectOption>
              </Select>
            </label>
            {draft.scope === "client" && (
              <label>
                <span>Cliente</span>
                <Select value={draft.client_id} onValueChange={(v) => setDraft({ ...draft, client_id: v })} aria-label="Cliente">
                  <SelectOption value="">Escolha o cliente</SelectOption>
                  {clients.map((c) => (
                    <SelectOption key={c.id} value={c.id}>
                      {c.name}
                    </SelectOption>
                  ))}
                </Select>
              </label>
            )}
            {draft.scope === "product" && (
              <label>
                <span>Produto</span>
                <Select value={draft.product_id} onValueChange={(v) => setDraft({ ...draft, product_id: v })} aria-label="Produto">
                  <SelectOption value="">Escolha o produto</SelectOption>
                  {products.map((p) => (
                    <SelectOption key={p.id} value={p.id}>
                      {p.name}
                    </SelectOption>
                  ))}
                </Select>
              </label>
            )}
            <label>
              <span>Tipo de insight</span>
              <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as LessonDraft["kind"] })} aria-label="Tipo de insight">
                <SelectOption value="">Todos</SelectOption>
                {(Object.keys(KIND_LABELS) as InsightKind[]).map((k) => (
                  <SelectOption key={k} value={k}>
                    {KIND_LABELS[k]}
                  </SelectOption>
                ))}
              </Select>
            </label>
          </div>
          <label>
            <span>Aprendizado</span>
            <Textarea
              rows={2}
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value.slice(0, 400) })}
              placeholder="Ex.: Para este cliente, não sugerir frete grátis: não há margem."
            />
          </label>
          <div className="cins-rule-actions">
            <Button className="btn secondary" onClick={() => setDraft(null)} disabled={busy}>
              Cancelar
            </Button>
            <Button
              className="btn primary"
              loading={busy}
              onClick={async () => {
                const ok = await act(
                  () =>
                    saveInsightLesson(company, {
                      ...(draft.id ? { id: draft.id } : {}),
                      scope: draft.scope,
                      client_id: draft.scope === "client" ? draft.client_id || null : null,
                      product_id: draft.scope === "product" ? draft.product_id || null : null,
                      kind: draft.kind || null,
                      text: draft.text,
                    }),
                  "Aprendizado salvo: vale nas próximas análises.",
                );
                if (ok) setDraft(null);
              }}
            >
              <Save size={15} aria-hidden="true" /> Salvar aprendizado
            </Button>
          </div>
        </div>
      ) : (
        <div className="cins-rule-actions start">
          <Button className="btn secondary" onClick={() => setDraft({ scope: "company", client_id: "", product_id: "", kind: "", text: "" })}>
            <Plus size={15} aria-hidden="true" /> Escrever um aprendizado
          </Button>
        </div>
      )}
    </section>
  );
}

/** Os ajustes por cliente ou por campanha. */
function RulesBlock({
  company,
  data,
  config,
  onChange,
  notify,
}: {
  company: string;
  data: Snapshot;
  config: InsightSettingsView;
  onChange: (c: InsightSettingsView) => void;
  notify: (message: string) => void;
}) {
  const [editing, setEditing] = useState<InsightRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<{ id: string; name: string; client: string }[]>([]);
  useEffect(() => {
    if (!editing || editing.client_id !== null || !search.trim()) {
      setFound([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      supabaseCampaigns
        .page(company, { scope: "active", search: search.trim(), platform: "", attention: false, limit: 10, offset: 0 })
        .then(
          (r) =>
            live &&
            setFound(
              r.rows
                .filter((x) => x.campaign.platform === "meta" || x.campaign.platform === "google")
                .map((x) => ({ id: x.campaign.id, name: x.campaign.name, client: x.client_name })),
            ),
        )
        .catch(() => live && setFound([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [company, search, editing]);
  const blank = (scope: "client" | "campaign"): InsightRule => ({
    client_id: scope === "client" ? "" : null,
    campaign_id: scope === "campaign" ? "" : null,
    enabled: true,
    frequency: config.settings.frequency,
    weekdays: config.settings.weekdays,
    every_days: config.settings.every_days,
    hour: config.settings.hour,
  });
  const save = async () => {
    if (!editing) return;
    if (editing.client_id === "" || editing.campaign_id === "") {
      setError(editing.client_id === "" ? "Escolha o cliente." : "Escolha a campanha.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onChange(await saveInsightRule(company, editing));
      setEditing(null);
      setSearch("");
      notify("Ajuste salvo.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try {
      onChange(await deleteInsightRule(company, id));
      notify("Ajuste removido: vale o padrão.");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const clients = [...data.clients].filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return (
    <section className="panel cins-block">
      <h3>Ajustes por cliente ou campanha</h3>
      <p className="cins-help">
        Uma frequência diferente (ou desligar) para um cliente — vale para todas as campanhas dele — ou para uma
        campanha. O ajuste da campanha vence o do cliente, que vence o padrão.
      </p>
      {config.rules.length > 0 && (
        <ul className="cins-rules">
          {config.rules.map((r) => (
            <li key={r.id}>
              <div>
                <strong>{r.campaign_id ? r.campaign_name : r.client_name}</strong>
                <small>
                  {r.campaign_id ? `Campanha · ${r.client_name ?? ""}` : "Cliente (todas as campanhas)"} ·{" "}
                  {scheduleText(r)}
                </small>
              </div>
              <button type="button" className="icon-btn" title="Editar" aria-label="Editar o ajuste" onClick={() => setEditing({ ...r })}>
                <Pencil size={15} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Remover"
                aria-label="Remover o ajuste"
                onClick={() => void remove(r.id!)}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <div className="cins-rule-editor">
          {editing.id ? (
            <p className="cins-help">
              <strong>{editing.campaign_id ? editing.campaign_name : editing.client_name}</strong>
            </p>
          ) : editing.client_id !== null ? (
            <label>
              <span>Cliente</span>
              <Select
                value={editing.client_id ?? ""}
                onValueChange={(v) => setEditing({ ...editing, client_id: v })}
                aria-label="Cliente"
              >
                <SelectOption value="">Escolha o cliente</SelectOption>
                {clients.map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {c.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
          ) : (
            <label>
              <span>Campanha</span>
              {editing.campaign_id ? (
                <span className="cins-picked">
                  {editing.campaign_name}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Trocar a campanha"
                    onClick={() => setEditing({ ...editing, campaign_id: "", campaign_name: null })}
                  >
                    <X size={14} />
                  </button>
                </span>
              ) : (
                <>
                  <Input
                    type="search"
                    placeholder="Buscar campanha ativa…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {found.length > 0 && (
                    <ul className="cins-found">
                      {found.map((f) => (
                        <li key={f.id}>
                          <button
                            type="button"
                            onClick={() => setEditing({ ...editing, campaign_id: f.id, campaign_name: f.name })}
                          >
                            <strong>{f.name}</strong> <small>{f.client}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </label>
          )}
          <label className="cins-check">
            <Checkbox checked={editing.enabled} onCheckedChange={(v) => setEditing({ ...editing, enabled: v === true })} />
            <span>
              <strong>Analisar</strong>
              <small>Desmarcado: sem análises agendadas e sem "Analisar agora".</small>
            </span>
          </label>
          {editing.enabled && (
            <ScheduleFields idPrefix="cins-rule" value={editing} onChange={(v) => setEditing({ ...editing, ...v })} />
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="cins-rule-actions">
            <Button
              className="btn secondary"
              onClick={() => {
                setEditing(null);
                setError("");
                setSearch("");
              }}
            >
              Cancelar
            </Button>
            <Button className="btn primary" onClick={() => void save()} loading={busy}>
              <Save size={15} aria-hidden="true" /> Salvar ajuste
            </Button>
          </div>
        </div>
      ) : (
        <div className="cins-rule-actions start">
          <Button className="btn secondary" onClick={() => setEditing(blank("client"))}>
            <Plus size={15} aria-hidden="true" /> Ajuste de cliente
          </Button>
          <Button className="btn secondary" onClick={() => setEditing(blank("campaign"))}>
            <Plus size={15} aria-hidden="true" /> Ajuste de campanha
          </Button>
        </div>
      )}
    </section>
  );
}
