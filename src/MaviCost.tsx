import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Coins } from "lucide-react";
import type { AiRouteInfo, ConversationCost, TurnCost, TurnDetail } from "./ai";

/**
 * MAVI · o custo de cada resposta e da conversa inteira, por modelo
 * (migração 20261224090000_mavi_conversation_cost). Só quem começou a
 * conversa e os gestores veem (o banco confere).
 */

/** Dólares com as casas que importam (respostas custam frações de centavo). */
export function usd(v: number) {
  const n = Number(v) || 0;
  if (n === 0) return "US$ 0,00";
  if (n < 0.0001) return "< US$ 0,0001";
  return `US$ ${n.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: n >= 1 ? 2 : 4,
  })}`;
}
const tokens = (v: number) => {
  const n = Number(v) || 0;
  return n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`
    : n >= 1000
      ? `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`
      : n.toLocaleString("pt-BR");
};

/** Para que o modelo foi usado. */
const KIND: Record<string, string> = {
  ask: "resposta",
  search: "busca nos vetores",
  image: "imagem",
  canvas: "documento/apresentação",
  web: "busca na internet",
  skill: "skill",
  rerank: "reordenação da busca",
  summary: "resumo da conversa",
  attachment_index: "anexos (vetores)",
  attachment_image: "anexos (imagem)",
  attachment_transcription: "anexos (transcrição)",
};
export const kindLabel = (k: string) => KIND[k] ?? k;

type Row = {
  key: string;
  model: string;
  provider: string | null;
  kinds: string[];
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  embedding: number;
  cost: number;
};

/** O custo de uma resposta salva, no formato da que acabou de chegar. */
export function messageCost(costs: ConversationCost | null, id: number | undefined): TurnCost | null {
  const m = id ? costs?.by_message.find((x) => Number(x.message) === id) : undefined;
  if (!m) return null;
  const rows = new Map<string, TurnCost["models"][number]>();
  for (const i of m.items) {
    const key = `${i.provider}|${i.model}`;
    const r = rows.get(key) ?? {
      model: i.model,
      provider: i.provider || null,
      kinds: [],
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      embedding: 0,
      cost: 0,
    };
    r.input += Number(i.input_tokens) || 0;
    r.output += Number(i.output_tokens) || 0;
    r.cacheRead += Number(i.cache_read_tokens) || 0;
    r.cacheWrite += Number(i.cache_write_tokens) || 0;
    r.embedding += Number(i.embedding_tokens) || 0;
    r.cost += Number(i.cost) || 0;
    if (!r.kinds.includes(i.kind)) r.kinds.push(i.kind);
    rows.set(key, r);
  }
  const kinds = new Map<string, number>();
  for (const i of m.items) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + (Number(i.cost) || 0));
  return {
    cost: Number(m.cost) || 0,
    models: [...rows.values()].sort((a, b) => b.cost - a.cost),
    kinds: [...kinds.entries()].map(([kind, cost]) => ({ kind, cost })).sort((a, b) => b.cost - a.cost),
    detail: m.detail ?? null,
  };
}

/** Os usos da resposta (vetores, imagens, anexos, resumo…). */
const kindsOf = (cost: TurnCost) => cost.kinds ?? [];
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s` : `${Math.round(v)} ms`);

/** Tudo o que aconteceu na resposta: de onde veio a entrada, cada rodada e cada ferramenta. */
function Steps({ detail, kinds }: { detail: TurnDetail; kinds: { kind: string; cost: number }[] }) {
  const p = detail.prompt;
  const parts: [string, number][] = [
    ["Sua mensagem", p.question],
    ["Skills e anexos colados na mensagem", p.extras],
    ["Histórico da conversa (mensagens suas e da MAVI)", p.history],
    ["Instruções e ferramentas da MAVI", p.instructions],
    ["Contexto (empresa, cliente, data, catálogos)", p.context],
  ];
  const others = kinds.filter((k) => k.kind !== "ask");
  const tools = new Map(detail.tools.map((t) => [t.tool, t]));
  return (
    <div className="mavi-cost-steps">
      {detail.rounds.length > 0 && (
        <section>
          <h4>Entrada da 1ª rodada (≈, pelo tamanho de cada parte)</h4>
          <ul>
            {parts
              .filter(([, n]) => n > 0)
              .map(([label, n]) => (
                <li key={label}>
                  <span>{label}</span>
                  <span className="num">{tokens(n)}</span>
                </li>
              ))}
          </ul>
        </section>
      )}
      {detail.rounds.length > 0 && (
        <section>
          <h4>Rodadas do modelo</h4>
          <ol>
            {detail.rounds.map((r, i) => (
              <li key={i}>
                <span>
                  <strong>
                    {i + 1}ª · {r.model}
                  </strong>
                  <small>
                    entrada {tokens(r.input + r.cacheRead + r.cacheWrite)}
                    {r.cacheRead ? ` (${tokens(r.cacheRead)} do cache)` : ""} · saída {tokens(r.output)}
                    {r.tools.length
                      ? ` · pediu ${r.tools.map((t) => tools.get(t)?.label ?? t).join(", ")}`
                      : " · escreveu a resposta"}
                  </small>
                </span>
                <span className="num">{usd(r.cost)}</span>
              </li>
            ))}
          </ol>
          <p className="mavi-cost-note">
            A saída ({tokens(detail.output)}) inclui o raciocínio e os pedidos de ferramentas; o texto da resposta
            tem ≈ {tokens(detail.answer)}. O resultado de cada ferramenta entra na rodada seguinte.
          </p>
        </section>
      )}
      {detail.tools.length > 0 && (
        <section>
          <h4>Ferramentas e skills</h4>
          <ul>
            {detail.tools.map((t, i) => (
              <li key={i} className={t.ok ? "" : "failed"}>
                <span>
                  {t.label}
                  <small>
                    {ms(t.ms)}
                    {t.ok ? "" : " · falhou"}
                    {t.cost ? "" : " · sem custo próprio"}
                  </small>
                </span>
                <span className="num">{t.cost ? usd(t.cost) : "—"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section>
          <h4>Outros gastos desta resposta</h4>
          <ul>
            {others.map((k) => (
              <li key={k.kind}>
                <span>{kindLabel(k.kind)}</span>
                <span className="num">{usd(k.cost)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ModelTable({ rows }: { rows: Row[] }) {
  return (
    <table className="mavi-cost-table">
      <thead>
        <tr>
          <th>Modelo</th>
          <th className="num">Entrada</th>
          <th className="num">Saída</th>
          <th className="num">Custo</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <strong>{r.model}</strong>
              <small>
                {[r.provider || "Padrão do servidor", r.kinds.map(kindLabel).join(", ")].filter(Boolean).join(" · ")}
              </small>
            </td>
            <td className="num">
              {r.embedding && !r.input ? (
                <span title="Tokens de vetores">{tokens(r.embedding)}</span>
              ) : (
                <>
                  {tokens(r.input + r.cacheRead + r.cacheWrite)}
                  {r.cacheRead > 0 && (
                    <small title="Lidos do cache do prompt (custam ~10% da entrada)">
                      {tokens(r.cacheRead)} do cache
                    </small>
                  )}
                </>
              )}
            </td>
            <td className="num">{tokens(r.output)}</td>
            <td className="num">{usd(r.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const turnRows = (c: TurnCost): Row[] =>
  c.models.map((m) => ({ ...m, key: `${m.provider ?? ""}|${m.model}` }));

/** O custo de uma resposta (no rodapé dela), com os modelos ao clicar e, para líderes, o porquê do modelo. */
export function AnswerCost({ cost, route }: { cost: TurnCost; route?: AiRouteInfo }) {
  const [open, setOpen] = useState(false);
  const n = cost.models.length;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="mavi-cost-chip"
          title="O custo desta resposta, por modelo"
          aria-label={`Custo desta resposta: ${usd(cost.cost)}`}
        >
          <Coins size={13} aria-hidden="true" />
          {usd(cost.cost)}
          {n > 1 && <span className="mavi-cost-models">· {n} modelos</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="mavi-cost-pop" align="start" sideOffset={6}>
          <strong>Custo desta resposta</strong>
          {route && <RouteWhy route={route} />}
          <ModelTable rows={turnRows(cost)} />
          {cost.detail && <Steps detail={cost.detail} kinds={kindsOf(cost)} />}
          <p className="mavi-cost-total">
            Total <strong>{usd(cost.cost)}</strong>
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Por que esta resposta usou o seu modelo (o roteador; Painel da MAVI › Roteamento). */
function RouteWhy({ route }: { route: AiRouteInfo }) {
  const how =
    route.mode === "auto"
      ? "escolhido pela MAVI"
      : route.mode === "locked"
        ? "regra de Quem usa qual modelo"
        : "regra ou padrão (roteador em sombra)";
  return (
    <div className="mavi-cost-route">
      <p>
        <strong>{route.model}</strong> · {how}
        {route.escalated && " · segunda tentativa"}
      </p>
      {route.mode !== "auto" && route.suggested && route.suggested !== route.model && (
        <p className="muted">O roteador escolheria {route.suggested}.</p>
      )}
      <p className="muted">{route.reason}</p>
    </div>
  );
}

/** O custo da conversa inteira (no topo): total, por modelo e por uso. */
export function ConversationCostButton({ costs }: { costs: ConversationCost }) {
  const [open, setOpen] = useState(false);
  const t = costs.total;
  const rows: Row[] = costs.by_model.map((m) => ({
    key: `${m.provider}|${m.model}`,
    model: m.model,
    provider: m.provider || null,
    kinds: m.kinds ?? [],
    input: Number(m.input_tokens) || 0,
    output: Number(m.output_tokens) || 0,
    cacheRead: Number(m.cache_read_tokens) || 0,
    cacheWrite: Number(m.cache_write_tokens) || 0,
    embedding: Number(m.embedding_tokens) || 0,
    cost: Number(m.cost) || 0,
  }));
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="btn secondary mavi-cost-btn"
          title="Quanto esta conversa custou, por modelo"
        >
          <Coins size={15} aria-hidden="true" /> <span>{usd(t.cost)}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="mavi-cost-pop wide" align="end" sideOffset={6}>
          <strong>Custo desta conversa</strong>
          <p className="mavi-cost-sub">
            {Number(t.answers) || 0} {Number(t.answers) === 1 ? "resposta" : "respostas"} ·{" "}
            {rows.length} {rows.length === 1 ? "modelo" : "modelos"} · entrada{" "}
            {tokens(Number(t.input_tokens) + Number(t.cache_read_tokens) + Number(t.cache_write_tokens))} · saída{" "}
            {tokens(Number(t.output_tokens))} tokens
          </p>
          {rows.length ? (
            <ModelTable rows={rows} />
          ) : (
            <p className="muted">Nenhum gasto registrado ainda.</p>
          )}
          {costs.by_kind.length > 1 && (
            <div className="mavi-cost-kinds">
              {costs.by_kind.map((k) => (
                <span key={k.kind}>
                  {kindLabel(k.kind)} <strong>{usd(Number(k.cost))}</strong>
                </span>
              ))}
            </div>
          )}
          <p className="mavi-cost-total">
            Total <strong>{usd(Number(t.cost))}</strong>
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
