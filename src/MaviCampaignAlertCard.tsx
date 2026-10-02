import { useState } from "react";
import { Ban, BellRing, Check, ExternalLink, Loader2, Sparkles, X } from "lucide-react";
import { setActionState } from "./ai";
import { channelText, conditionText, repeatText, scopeText } from "./campaign-alerts";
import { deleteCampaignAlert, saveCampaignAlert } from "./campaign-alerts-api";
import type { ActionArtifact, ActionProposal } from "./mavi-artifacts";
import "./mavi-artifacts.css";

/** Onde o cartão aparece: a conversa (módulo MAVI ou bolinha). */
export type AlertCardHost = {
  company: string;
  conversation: string | null;
  readOnly: boolean;
  streaming: boolean;
  notify: (message: string) => void;
};

/**
 * Campanhas › Meus avisos: o aviso que a MAVI montou (criar, mudar ou
 * excluir). Grava só quando a pessoa confirma, pela mesma função da tela;
 * na bolinha e no módulo MAVI.
 */
export function CampaignAlertCard({
  artifact,
  host,
}: {
  artifact: ActionArtifact;
  host: AlertCardHost;
}) {
  const a = artifact.action as Extract<ActionProposal, { kind: "campaign_alert" }>;
  const [state, setState] = useState(artifact.state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const waiting = host.streaming || !host.conversation;
  const rule = a.rule;
  async function decide(next: "confirmed" | "cancelled") {
    if (!host.conversation) return;
    setBusy(true);
    setError("");
    try {
      let result: Record<string, unknown> = {};
      if (next === "confirmed") {
        if (a.op === "delete") await deleteCampaignAlert(host.company, rule.id!);
        else result = { rule_id: (await saveCampaignAlert(host.company, { ...rule, origin: "mavi" })).id };
      }
      await setActionState(host.conversation, artifact.id, next, result);
      setState(next);
      if (next === "confirmed")
        host.notify(a.op === "delete" ? "Aviso excluído." : a.op === "update" ? "Aviso atualizado." : "Aviso criado.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const verb = { create: "Novo aviso", update: "Mudança no aviso", delete: "Excluir o aviso" }[a.op];
  const fields: [string, string][] =
    a.op === "delete"
      ? [["Quando", conditionText(rule)]]
      : [
          ["Quando", conditionText(rule)],
          ["Onde", scopeText(rule)],
          ["Repetição", repeatText(rule)],
          ["Entrega", channelText(rule.channel)],
          ...(rule.active ? [] : [["Situação", "desligado (não avisa até ser ligado)"] as [string, string]]),
        ];
  return (
    <section className={`mavi-card mavi-action ${state}`} aria-label="Aviso de campanha proposto pela MAVI">
      <header className="mavi-action-head">
        <span className="mavi-action-icon" aria-hidden="true">
          <BellRing size={16} />
        </span>
        <span>
          <small>
            <Sparkles size={11} aria-hidden="true" /> {verb} de campanha · proposta da MAVI
          </small>
          <strong>{rule.name}</strong>
        </span>
        <StateChip state={state} />
      </header>
      <dl className="mavi-action-fields">
        {fields.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer className="mavi-action-foot">
        {state === "pending" ? (
          host.readOnly ? (
            <small>Só quem começou a conversa decide.</small>
          ) : (
            <>
              <button
                type="button"
                className="btn primary"
                disabled={waiting || busy}
                onClick={() => void decide("confirmed")}
              >
                {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
                {a.op === "delete" ? "Excluir" : a.op === "update" ? "Salvar mudança" : "Criar aviso"}
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={waiting || busy}
                onClick={() => void decide("cancelled")}
              >
                <X size={15} /> Cancelar
              </button>
              {waiting && <small>Aguardando a MAVI terminar…</small>}
            </>
          )
        ) : (
          state === "confirmed" &&
          a.op !== "delete" && (
            <a className="mavi-action-link" href="/campanhas?avisos=lista">
              <ExternalLink size={14} /> Ver em Meus avisos
            </a>
          )
        )}
      </footer>
    </section>
  );
}

/** A situação de uma ação proposta (todas as ações da MAVI usam). */
export function StateChip({ state }: { state: ActionArtifact["state"] }) {
  const map = {
    pending: ["Aguardando você", null],
    confirmed: ["Confirmada", <Check key="i" size={12} aria-hidden="true" />],
    cancelled: ["Cancelada", <Ban key="i" size={12} aria-hidden="true" />],
    failed: ["Não deu certo", <X key="i" size={12} aria-hidden="true" />],
  } as const;
  const [label, icon] = map[state];
  return (
    <span className={`mavi-action-state ${state}`}>
      {icon}
      {label}
    </span>
  );
}
