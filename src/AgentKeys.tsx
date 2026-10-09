import { useCallback, useContext, useEffect, useState } from "react";
import { CircleCheck, CircleAlert, KeyRound, Trash2 } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { agentOp, errorOf, PROVIDER_LABEL, refKind, when, type AgentDraft, type AgentSecrets } from "./agent-builder";
import { ModelOptionsContext, normalizeRef } from "./AgentBuilderFields";

/**
 * Chaves de API do agente: cada agente pode pagar as próprias conversas
 * (OpenRouter, OpenAI…). A chave vai direto para o cofre do motor; aqui
 * volta só o final dela. Sem chave do provedor do modelo, paga a da Make
 * Vendas (quando o motor tiver uma para ele).
 */
export function AgentKeysSection({
  company,
  agentId,
  draft,
  canEdit,
  notify,
}: {
  company: string;
  agentId: string;
  draft: AgentDraft;
  canEdit: boolean;
  notify: (m: string) => void;
}) {
  const models = useContext(ModelOptionsContext);
  const [data, setData] = useState<AgentSecrets | null>(null);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    agentOp<AgentSecrets>(company, agentId, "keys")
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId]);
  useEffect(load, [load]);

  // O modelo que vai responder (o escolhido ou o padrão do Painel) e quem paga.
  const ref = normalizeRef(draft?.model?.model) || models?.models.find((m) => m.key === models.default)?.ref || "";
  const kind = refKind(ref);
  useEffect(() => {
    if (!provider && kind) setProvider(kind);
  }, [kind, provider]);
  const own = data?.secrets.find((s) => s.provider === kind);
  const payer = !kind
    ? null
    : own
      ? { ok: own.check_ok !== false, text: `Chave do agente (${PROVIDER_LABEL[kind] ?? kind} …${own.key_hint})` }
      : data?.server_providers.includes(kind)
        ? { ok: true, text: `Chave da Make Vendas (${PROVIDER_LABEL[kind] ?? kind}), porque o agente não tem chave própria desse provedor` }
        : { ok: false, text: `Sem chave da ${PROVIDER_LABEL[kind] ?? kind}: cadastre abaixo, senão o agente usa o modelo reserva` };

  return (
    <section className="ab-section">
      <h3>
        <KeyRound size={15} aria-hidden="true" /> Chaves de API do agente
      </h3>
      <p className="ab-hint ab-section-intro">
        Para este agente pagar as próprias conversas, cadastre a chave do provedor do modelo escolhido. A chave fica guardada
        cifrada no motor e não aparece de novo aqui.
      </p>
      {payer && (
        <p className={`ab-notice ${payer.ok ? "" : "warn"}`}>
          {payer.ok ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
          Quem paga agora: {payer.text}.
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <Loading variant="list" />}
      {data && data.secrets.length > 0 && (
        <ul className="ab-list">
          {data.secrets.map((s) => (
            <li key={s.provider} className="ab-row">
              <span className="ab-row-main">
                <strong>
                  {PROVIDER_LABEL[s.provider] ?? s.provider} <code className="ab-code">…{s.key_hint}</code>
                </strong>
                <span className={s.check_ok === false ? "ab-error" : "ab-hint"}>
                  {s.check_ok === false ? s.check_error ?? "A chave não passou na conferência." : "Conferida no provedor"}
                  {s.checked_at ? ` · ${when(s.checked_at)}` : ""}
                  {s.updated_by ? ` · ${s.updated_by}` : ""}
                </span>
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="agent-link-btn danger"
                  aria-label={`Remover a chave da ${PROVIDER_LABEL[s.provider] ?? s.provider}`}
                  onClick={() => {
                    if (!window.confirm(`Remover a chave da ${PROVIDER_LABEL[s.provider] ?? s.provider} deste agente?`)) return;
                    agentOp(company, agentId, "key-delete", { provider: s.provider })
                      .then(() => {
                        notify("Chave removida.");
                        load();
                      })
                      .catch((e) => notify(errorOf(e)));
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="ab-key-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!provider || !key.trim()) return;
            setBusy(true);
            agentOp<{ check_ok: boolean; check_error: string | null; key_hint: string }>(company, agentId, "key-set", { provider, key: key.trim() })
              .then((r) => {
                setKey("");
                notify(r.check_ok ? `Chave salva e conferida (…${r.key_hint}).` : `Chave salva, mas o provedor recusou: ${r.check_error ?? "confira a chave"}.`);
                load();
              })
              .catch((err) => notify(errorOf(err)))
              .finally(() => setBusy(false));
          }}
        >
          <div className="ab-field">
            <span className="ab-label">Provedor</span>
            <Select value={provider} onValueChange={setProvider} aria-label="Provedor da chave">
              <SelectOption value="">Escolha…</SelectOption>
              {Object.entries(PROVIDER_LABEL).map(([id, label]) => (
                <SelectOption key={id} value={id}>
                  {data?.secrets.some((s) => s.provider === id) ? `${label} (trocar a chave)` : label}
                </SelectOption>
              ))}
            </Select>
          </div>
          <div className="ab-field">
            <span className="ab-label">Chave de API</span>
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={provider === "openrouter" ? "sk-or-v1-…" : provider === "openai" ? "sk-…" : "Cole a chave"}
            />
          </div>
          <Button type="submit" className="btn secondary" loading={busy} disabled={!provider || key.trim().length < 10}>
            Salvar e conferir
          </Button>
        </form>
      )}
    </section>
  );
}
