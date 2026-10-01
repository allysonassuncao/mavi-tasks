import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Minus, Pencil, Plus, Send, Sparkles, X } from "lucide-react";
import { Button, Checkbox, Textarea } from "./ui";
import { PanelChart } from "./DashboardCharts";
import { buildDisplay, rangeOptions, type Panel, type PanelResult, type PanelSpec, type RangePreset } from "./dashboards";
import {
  askDashboardMavi,
  proposalItems,
  type DashContext,
  type DashMessage,
  type DashQuestion,
  type ProposalItem,
} from "./dashboard-mavi";
import "./dashboard-mavi.css";

/**
 * MAVI nos Dashboards: a conversa ao lado do dashboard. A pessoa conta o que
 * quer acompanhar; a MAVI pergunta (com opções para clicar), confere os
 * dados e propõe painéis com a prévia real. "Aplicar" leva para o dashboard
 * em edição; "Salvar" do dashboard grava.
 */

type Proposal = {
  items: ProposalItem[];
  state: "open" | "applied" | "discarded";
};
type Bubble = {
  role: "user" | "assistant";
  content: string;
  question?: DashQuestion;
  proposal?: Proposal;
  dropped?: string[];
};

const START_NEW: Bubble = {
  role: "assistant",
  content:
    "Oi! Me conta o que você quer acompanhar neste dashboard — com as suas palavras. Eu pergunto o que faltar, confiro os dados e monto os painéis para você ver antes de aplicar.",
  question: {
    text: "Por onde começamos?",
    options: [
      "Entregas e atrasos da equipe",
      "Horas trabalhadas por cliente e pessoa",
      "Performance de cada pessoa",
      "Validações e retrabalho",
    ],
    multiple: false,
  },
};
const START_EDIT: Bubble = {
  role: "assistant",
  content:
    "Oi! Posso adicionar painéis, mudar os que já existem ou explicar o que um número mostra. O que você quer?",
  question: {
    text: "O que você quer fazer?",
    options: ["Adicionar um painel", "Mudar um painel", "Explicar um painel", "Sugerir melhorias para este dashboard"],
    multiple: false,
  },
};
const startFocus = (title: string): Bubble => ({
  role: "assistant",
  content: `Sobre o painel “${title}”: quer entender o que ele mostra ou mudar alguma coisa?`,
  question: {
    text: "O que você quer fazer com este painel?",
    options: ["Explicar este painel", "Mudar o tipo de gráfico", "Filtrar por cliente, equipe ou pessoa", "Dividir por pessoa ou por cliente"],
    multiple: false,
  },
});

/** A proposta em texto, para a MAVI lembrar o que propôs e o que a pessoa fez. */
function proposalText(p: Proposal) {
  const parts = p.items.map((i) =>
    i.kind === "add"
      ? `+ painel “${i.panel.title}”`
      : i.kind === "update"
        ? `alterar “${i.before.title}”`
        : i.kind === "remove"
          ? `remover “${i.before.title}”`
          : i.kind === "name"
            ? `nome “${i.value}”`
            : i.kind === "description"
              ? "descrição"
              : `período ${i.value}`,
  );
  const state = p.state === "applied" ? "aplicada" : p.state === "discarded" ? "descartada" : "ainda não aplicada";
  return `[Proposta ${state}: ${parts.join("; ")}]`;
}

type Preview = (spec: PanelSpec, range?: RangePreset) => Promise<PanelResult>;

function MiniPreview({ spec, title, range, preview }: { spec: PanelSpec; title: string; range?: RangePreset; preview: Preview }) {
  const [result, setResult] = useState<PanelResult | null>(null);
  const [error, setError] = useState("");
  const key = JSON.stringify([spec, range]);
  useEffect(() => {
    let current = true;
    setResult(null);
    setError("");
    preview(spec, range)
      .then((r) => current && setResult(r))
      .catch((e) => current && setError((e as Error).message));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const display = useMemo(() => (result ? buildDisplay(spec, result) : null), [result, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`dash-panel dash-mavi-preview ${spec.viz === "stat" ? "stat" : ""}`} aria-label={`Prévia de ${title}`}>
      <div className="dash-panel-body">
        {error ? (
          <p className="dash-error" role="alert">
            {error}
          </p>
        ) : display ? (
          <PanelChart display={display} spec={spec} />
        ) : (
          <span className="dash-mavi-loading">Calculando a prévia…</span>
        )}
      </div>
    </div>
  );
}

const rangeName = (key: string) => rangeOptions.find((r) => r.key === key)?.label ?? key;

function ProposalCard({
  proposal,
  preview,
  onApply,
  onDiscard,
  busy,
}: {
  proposal: Proposal;
  preview: Preview;
  onApply: (items: ProposalItem[]) => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const [off, setOff] = useState<string[]>([]);
  const open = proposal.state === "open";
  const chosen = proposal.items.filter((i) => !off.includes(i.key));
  // A prévia já com o período que a MAVI propôs (se a pessoa o mantiver).
  const range = chosen.find((i) => i.kind === "range")?.value as RangePreset | undefined;
  return (
    <div className={`dash-mavi-proposal ${proposal.state}`}>
      <strong>
        {proposal.state === "applied"
          ? "Aplicado no dashboard"
          : proposal.state === "discarded"
            ? "Proposta descartada"
            : "Proposta da MAVI"}
      </strong>
      <ul>
        {proposal.items.map((item) => {
          const on = !off.includes(item.key);
          const Icon = item.kind === "add" ? Plus : item.kind === "remove" ? Minus : Pencil;
          const label =
            item.kind === "add"
              ? `Novo painel: ${item.panel.title}`
              : item.kind === "update"
                ? `Alterar: ${item.before.title}${item.panel.title !== item.before.title ? ` → ${item.panel.title}` : ""}`
                : item.kind === "remove"
                  ? `Remover: ${item.before.title}`
                  : item.kind === "name"
                    ? `Nome do dashboard: ${item.value}`
                    : item.kind === "description"
                      ? `Descrição: ${item.value}`
                      : `Período padrão: ${rangeName(item.value)}`;
          return (
            <li key={item.key} className={on ? "" : "off"}>
              <label className="checkbox-label">
                {open && (
                  <Checkbox
                    checked={on}
                    onCheckedChange={(v) =>
                      setOff((o) => (v === true ? o.filter((k) => k !== item.key) : [...o, item.key]))
                    }
                    aria-label={`Incluir: ${label}`}
                  />
                )}
                <Icon size={13} aria-hidden="true" />
                <span>{label}</span>
              </label>
              {(item.kind === "add" || item.kind === "update") && (
                <>
                  {item.panel.why && <small>{item.panel.why}</small>}
                  {open && on && <MiniPreview spec={item.panel.spec} title={item.panel.title} range={range} preview={preview} />}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {open && (
        <div className="dash-mavi-proposal-actions">
          <Button className="btn secondary" onClick={onDiscard} disabled={busy}>
            Descartar
          </Button>
          <Button className="btn primary" onClick={() => onApply(chosen)} disabled={busy || !chosen.length}>
            <CheckCircle2 size={14} /> Aplicar {chosen.length > 1 ? chosen.length : ""}
          </Button>
        </div>
      )}
    </div>
  );
}

export function DashboardAssistant({
  company,
  context,
  focus,
  onClearFocus,
  preview,
  onApply,
  onClose,
}: {
  company: string;
  /** O dashboard como está agora (o rascunho, se estiver editando). */
  context: () => DashContext;
  /** O painel de onde a pessoa abriu a conversa. */
  focus: Panel | null;
  onClearFocus: () => void;
  /** A prévia de um painel (com outro período, se a MAVI propôs um). */
  preview: Preview;
  onApply: (items: ProposalItem[]) => void;
  onClose: () => void;
}) {
  const [bubbles, setBubbles] = useState<Bubble[]>(() => [
    focus ? startFocus(focus.title) : context().isNew || !context().panels.length ? START_NEW : START_EDIT,
  ]);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const lastFocus = useRef(focus?.id ?? null);
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [bubbles, busy]);
  // Aberta por outro painel com a conversa já aberta: a MAVI pergunta dele.
  useEffect(() => {
    if (!focus || focus.id === lastFocus.current) return;
    lastFocus.current = focus.id;
    setBubbles((b) => [...b, startFocus(focus.title)]);
  }, [focus]);

  async function send(content: string) {
    const say = content.trim();
    if (!say || busy) return;
    setError("");
    setText("");
    setPicked([]);
    const next: Bubble[] = [...bubbles, { role: "user", content: say }];
    setBubbles(next);
    setBusy(true);
    try {
      // A pergunta, as opções e as propostas vão junto: a MAVI sabe o que fez.
      const messages: DashMessage[] = next.map((b) => ({
        role: b.role,
        content: [
          b.content,
          b.question
            ? `${b.question.text}${b.question.options.length ? ` (opções: ${b.question.options.join("; ")})` : ""}`
            : "",
          b.proposal ? proposalText(b.proposal) : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      }));
      const ctx = { ...context(), focus: focus?.id ?? null };
      const r = await askDashboardMavi(company, messages, ctx);
      const items = r.proposal ? proposalItems(r.proposal, ctx.panels) : [];
      setBubbles((b) => [
        ...b,
        {
          role: "assistant",
          content: r.reply,
          question: r.question,
          dropped: r.dropped,
          ...(items.length ? { proposal: { items, state: "open" as const } } : {}),
        },
      ]);
    } catch (e) {
      setError((e as Error).message);
      setBubbles((b) => b.slice(0, -1));
      setText(say);
    } finally {
      setBusy(false);
    }
  }
  const setProposal = (index: number, state: Proposal["state"]) =>
    setBubbles((b) => b.map((x, i) => (i === index && x.proposal ? { ...x, proposal: { ...x.proposal, state } } : x)));

  const last = bubbles[bubbles.length - 1];
  const question = last.role === "assistant" && !busy ? last.question : undefined;
  return (
    <aside className="panel dash-mavi" aria-label="MAVI nos Dashboards">
      <header>
        <Sparkles size={17} aria-hidden="true" />
        <div>
          <strong>Montar com a MAVI</strong>
          <small>Ela pergunta, confere os dados e mostra a prévia antes de aplicar.</small>
        </div>
        <button type="button" className="icon-btn" aria-label="Fechar a conversa com a MAVI" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <ol className="dash-mavi-list" ref={list} aria-live="polite">
        {bubbles.map((b, i) => (
          <li key={i} className={`dash-mavi-msg ${b.role}`}>
            {b.content && <p>{b.content}</p>}
            {b.question && <p className="dash-mavi-q">{b.question.text}</p>}
            {!!b.dropped?.length && (
              <small className="dash-mavi-dropped">
                Deixei de fora o que não passou na conferência: {b.dropped.join(" ")}
              </small>
            )}
            {b.proposal && (
              <ProposalCard
                proposal={b.proposal}
                preview={preview}
                busy={busy}
                onDiscard={() => setProposal(i, "discarded")}
                onApply={(items) => {
                  onApply(items);
                  setProposal(i, "applied");
                  setBubbles((x) => [
                    ...x,
                    {
                      role: "assistant",
                      content:
                        "Apliquei no dashboard. Confira os painéis e clique em Salvar para gravar. Se quiser, continue pedindo ajustes por aqui.",
                    },
                  ]);
                }}
              />
            )}
          </li>
        ))}
        {busy && (
          <li className="dash-mavi-msg assistant typing" aria-label="A MAVI está conferindo os dados">
            <span />
            <span />
            <span />
          </li>
        )}
      </ol>
      {question && !!question.options.length && (
        <div className="dash-mavi-options" role="group" aria-label={question.text}>
          {question.options.map((o) =>
            question.multiple ? (
              <button
                key={o}
                type="button"
                aria-pressed={picked.includes(o)}
                className={picked.includes(o) ? "on" : ""}
                onClick={() => setPicked((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]))}
              >
                {o}
              </button>
            ) : (
              <button key={o} type="button" onClick={() => void send(o)}>
                {o}
              </button>
            ),
          )}
          {question.multiple && !!picked.length && (
            <Button className="btn primary" onClick={() => void send(picked.join("; "))}>
              <Send size={13} /> Enviar {picked.length}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {focus && (
        <span className="dash-mavi-focus">
          Sobre o painel “{focus.title}”
          <button type="button" aria-label="Falar do dashboard inteiro" title="Falar do dashboard inteiro" onClick={onClearFocus}>
            <X size={12} />
          </button>
        </span>
      )}
      <form
        className="dash-mavi-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <Textarea
          rows={2}
          value={text}
          maxLength={4000}
          placeholder={question ? "Responda aqui, com as suas palavras…" : "Descreva o que quer ver ou peça um ajuste…"}
          aria-label="Mensagem para a MAVI"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <Button className="btn primary" type="submit" loading={busy} disabled={!text.trim()} aria-label="Enviar">
          <Send size={15} />
        </Button>
      </form>
    </aside>
  );
}
