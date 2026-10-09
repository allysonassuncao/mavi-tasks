import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { Button, Checkbox, Loading, Select, SelectOption } from "./ui";
import { agentModels, errorOf, priceText, setAgentModels, when, type AgentModels } from "./agent-builder";
import { WabaPricesSection } from "./AgentCosts";
import { TestLimitsSection } from "./AgentTestRuns";
import "./agent-builder.css";

/**
 * Painel da MAVI › Agentes MAVI: quais modelos (dos provedores cadastrados) os
 * agentes de WhatsApp podem usar, e o padrão e o reserva. O construtor só
 * oferece estes; quem paga é a chave de API do próprio agente ou a do motor.
 */
export function AgentModelsPanel({ company, notify }: { company: string; notify: (m: string) => void }) {
  const [data, setData] = useState<AgentModels | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [def, setDef] = useState("");
  const [fallback, setFallback] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    agentModels(company)
      .then((d) => {
        setData(d);
        setPicked(new Set(d.models.filter((m) => m.allowed).map((m) => m.key)));
        setDef(d.default ?? "");
        setFallback(d.fallback ?? "");
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company]);
  useEffect(load, [load]);

  const groups = useMemo(() => {
    const by = new Map<string, AgentModels["models"]>();
    for (const m of data?.models ?? []) by.set(m.provider_name, [...(by.get(m.provider_name) ?? []), m]);
    return [...by.entries()];
  }, [data]);
  const chosen = (data?.models ?? []).filter((m) => picked.has(m.key));
  const dirty =
    !!data &&
    (def !== (data.default ?? "") ||
      fallback !== (data.fallback ?? "") ||
      chosen.length !== data.models.filter((m) => m.allowed).length ||
      chosen.some((m) => !m.allowed));

  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!data) return <Loading variant="list" />;

  return (
    <div className="ab-stack ab-models-panel">
      <div>
        <h2 className="ab-title">
          <Bot size={18} aria-hidden="true" /> Agentes MAVI
        </h2>
        <p className="ab-hint ab-intro">
          Os modelos que os agentes de WhatsApp podem usar (em Agente Conversacional › Agentes MAVI › Comportamento ›
          Inteligência). Agente que já usa um modelo retirado daqui continua rodando até alguém editar e publicar de novo.
          Quem paga as conversas é a chave de API do próprio agente ou, sem ela, a da Make Vendas.
        </p>
      </div>
      {!data.models.length && (
        <div className="ab-notice">
          Nenhum modelo de conversa cadastrado num provedor que os agentes usam (OpenRouter, OpenAI, Anthropic, Google, DeepSeek,
          Groq, Mistral ou xAI). Um administrador cadastra em Provedores e modelos.
        </div>
      )}
      {groups.map(([provider, models]) => (
        <section key={provider} className="ab-section">
          <h3>{provider}</h3>
          <ul className="ab-model-list">
            {models.map((m) => {
              const id = `ab-model-${m.key}`;
              return (
                <li key={m.key} className="ab-check">
                  <Checkbox
                    id={id}
                    checked={picked.has(m.key)}
                    disabled={!data.can_edit}
                    onCheckedChange={(c) =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (c === true) n.add(m.key);
                        else {
                          n.delete(m.key);
                          if (def === m.key) setDef("");
                          if (fallback === m.key) setFallback("");
                        }
                        return n;
                      })
                    }
                  />
                  <label htmlFor={id}>
                    <span>
                      {m.label} <code className="ab-code">{m.model}</code>
                    </span>
                    <small className="ab-hint">{priceText(m)}</small>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {data.models.length > 0 && (
        <section className="ab-section">
          <h3>Padrão dos agentes</h3>
          <p className="ab-hint ab-section-intro">Usado pelos agentes que deixam o modelo em "Padrão do Painel".</p>
          <div className="ab-grid">
            <div className="ab-field">
              <span className="ab-label">Modelo padrão</span>
              <Select value={def} onValueChange={setDef} aria-label="Modelo padrão" disabled={!data.can_edit}>
                <SelectOption value="">Padrão do motor (Make Vendas)</SelectOption>
                {chosen.map((m) => (
                  <SelectOption key={m.key} value={m.key}>
                    {`${m.label} — ${m.provider_name}`}
                  </SelectOption>
                ))}
              </Select>
            </div>
            <div className="ab-field">
              <span className="ab-label">Modelo reserva padrão</span>
              <Select value={fallback} onValueChange={setFallback} aria-label="Modelo reserva padrão" disabled={!data.can_edit}>
                <SelectOption value="">Padrão do motor (Make Vendas)</SelectOption>
                {chosen
                  .filter((m) => m.key !== def)
                  .map((m) => (
                    <SelectOption key={m.key} value={m.key}>
                      {`${m.label} — ${m.provider_name}`}
                    </SelectOption>
                  ))}
              </Select>
              <small className="ab-hint">Entra quando o principal falha ou está sem chave.</small>
            </div>
          </div>
        </section>
      )}
      {data.can_edit && data.models.length > 0 && (
        <div className="ab-toolbar">
          <span className="ab-hint">{data.updated_at ? `Alterado em ${when(data.updated_at)}` : ""}</span>
          <Button
            type="button"
            className="btn primary"
            disabled={!dirty}
            loading={busy}
            onClick={() => {
              setBusy(true);
              setAgentModels(company, [...picked], def || null, fallback || null)
                .then(() => {
                  notify("Modelos dos agentes salvos.");
                  load();
                })
                .catch((e) => notify(errorOf(e)))
                .finally(() => setBusy(false));
            }}
          >
            Salvar
          </Button>
        </div>
      )}
      <TestLimitsSection company={company} notify={notify} />
      <WabaPricesSection company={company} notify={notify} />
    </div>
  );
}
