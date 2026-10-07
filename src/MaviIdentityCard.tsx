import { useState } from "react";
import { BookOpenText, Check, ExternalLink, Loader2, Palette, Sparkles, X } from "lucide-react";
import { setActionState } from "./ai";
import { loadBrand } from "./brand";
import { clientIdentity, getIdentity, listIdentities, saveIdentity } from "./identities";
import { IdentityPreview } from "./IdentityEditor";
import { StateChip } from "./MaviCampaignAlertCard";
import { driveUrl, pageUrl, routeParts } from "./router";
import {
  GUIDE_TEMPLATE,
  addToGuide,
  sanitizeTokens,
  tokensFromBrand,
  type IdentityTokens,
} from "./visual-identity";
import type { ActionArtifact, ActionProposal } from "./mavi-artifacts";

/**
 * A identidade visual que a MAVI propôs: uma inteira (tema e Guia da marca,
 * a partir da Marca, de um site ou de uma descrição) ou itens numa seção do
 * Guia da marca (o que a pessoa corrigiu). Grava só quando a pessoa
 * confirma, com as mesmas funções das telas: cada vez é uma versão, com o
 * motivo. Quem não atende o cliente não consegue gravar (o banco confere).
 */

type Host = {
  company: string;
  conversation: string | null;
  readOnly: boolean;
  streaming: boolean;
  notify: (message: string) => void;
};
type Proposal = Extract<ActionProposal, { kind: "identity" }>;

const today = () => new Date().toLocaleDateString("pt-BR");

/** A identidade que a proposta muda, lida agora (a mais nova). */
async function current(company: string, a: Proposal) {
  if (a.identity_id) return getIdentity(a.identity_id);
  if (a.scope === "client" && a.client_id) return clientIdentity(company, a.client_id);
  if (a.scope === "company") {
    const list = await listIdentities(company);
    return list.company ? getIdentity(list.company.id) : null;
  }
  return null;
}

/** Grava a proposta; devolve a identidade e a versão. */
export async function applyIdentityProposal(company: string, a: Proposal) {
  const now = await current(company, a);
  const reason = a.reason || (a.op === "save" ? "Proposta da MAVI" : `Guia: ${a.section}`);
  if (a.op === "save")
    return saveIdentity(company, {
      id: now?.id ?? null,
      scope: a.scope,
      client: a.client_id ?? null,
      name: a.identity_name,
      description: a.description ?? now?.description ?? "",
      tokens: sanitizeTokens(a.tokens),
      guide: a.guide ?? now?.guide ?? "",
      reason,
    });
  // Itens no guia: sem identidade ainda, ela nasce da Marca (cliente) ou do padrão.
  let tokens: IdentityTokens = now ? sanitizeTokens(now.tokens) : sanitizeTokens({});
  if (!now && a.scope === "client" && a.client_id) {
    const brand = await loadBrand(company, a.client_id).catch(() => null);
    if (brand) tokens = tokensFromBrand(brand);
  }
  const base = now?.guide ?? (a.scope === "gallery" ? "" : GUIDE_TEMPLATE);
  const guide = addToGuide(base, a.section ?? "Aprendizados", a.lines ?? [], /aprendiz/i.test(a.section ?? "") ? today() : undefined);
  return saveIdentity(company, {
    id: now?.id ?? null,
    scope: a.scope,
    client: a.client_id ?? null,
    name: now?.name ?? a.identity_name,
    description: now?.description ?? "",
    tokens,
    guide,
    reason,
  });
}

export function IdentityActionCard({ artifact, host }: { artifact: ActionArtifact; host: Host }) {
  const a = artifact.action as Proposal;
  const [state, setState] = useState(artifact.state);
  const [result, setResult] = useState(artifact.result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const waiting = host.streaming || !host.conversation;
  async function decide(next: "confirmed" | "cancelled") {
    if (!host.conversation) return;
    setBusy(true);
    setError("");
    try {
      let data: Record<string, unknown> = {};
      if (next === "confirmed") {
        const r = await applyIdentityProposal(host.company, a);
        data = { identity_id: r.id, version: r.version };
      }
      await setActionState(host.conversation, artifact.id, next, data);
      setState(next);
      setResult(data as ActionArtifact["result"]);
      if (next === "confirmed")
        host.notify(a.op === "save" ? `Identidade salva (versão ${data.version}).` : `Guia da marca atualizado (versão ${data.version}).`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const where =
    a.scope === "client" ? `Guia da marca de ${a.client_name || "cliente"}` : a.scope === "company" ? "Identidade da empresa" : "Galeria";
  const company = routeParts(window.location.pathname).company;
  const link =
    a.scope === "client" && a.client_id
      ? driveUrl({ client: a.client_id, brand: true }, company)
      : pageUrl("identities", company);
  return (
    <section className={`mavi-card mavi-action ${state}`} aria-label="Identidade visual proposta pela MAVI">
      <header className="mavi-action-head">
        <span className="mavi-action-icon" aria-hidden="true">
          {a.op === "save" ? <Palette size={16} /> : <BookOpenText size={16} />}
        </span>
        <span>
          <small>
            <Sparkles size={11} aria-hidden="true" /> {a.op === "save" ? (a.identity_id ? "Nova versão da identidade" : "Nova identidade") : "Adicionar ao guia"} · proposta da MAVI
          </small>
          <strong>{a.op === "save" ? a.identity_name : `${where} › ${a.section}`}</strong>
        </span>
        <StateChip state={state} />
      </header>
      {a.op === "save" && a.tokens ? (
        <div className="mavi-identity-body">
          <div className="mavi-identity-art">
            <IdentityPreview
              company={host.company}
              look={{ ...sanitizeTokens(a.tokens), id: a.identity_id ?? "proposta", name: a.identity_name, source: "custom" }}
              compact
            />
          </div>
          <dl className="mavi-action-fields">
            <div>
              <dt>Onde</dt>
              <dd>{where}</dd>
            </div>
            {a.description && (
              <div>
                <dt>Quando usar</dt>
                <dd>{a.description}</dd>
              </div>
            )}
            {a.reason && (
              <div>
                <dt>Por quê</dt>
                <dd>{a.reason}</dd>
              </div>
            )}
            <div>
              <dt>Guia</dt>
              <dd>
                {a.guide?.trim() ? (
                  <button type="button" className="link-btn" onClick={() => setOpen((x) => !x)}>
                    {open ? "Esconder" : `Ver o guia (${a.guide.length.toLocaleString("pt-BR")} caracteres)`}
                  </button>
                ) : (
                  "mantém o atual"
                )}
              </dd>
            </div>
          </dl>
          {open && a.guide && <pre className="mavi-identity-guide">{a.guide}</pre>}
        </div>
      ) : (
        <div className="mavi-identity-body">
          <ul className="mavi-identity-lines">
            {(a.lines ?? []).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {a.reason && <p className="mavi-identity-reason">{a.reason}</p>}
        </div>
      )}
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
              <button type="button" className="btn primary" disabled={waiting || busy} onClick={() => void decide("confirmed")}>
                {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
                {a.op === "save" ? "Salvar identidade" : "Adicionar ao guia"}
              </button>
              <button type="button" className="btn secondary" disabled={waiting || busy} onClick={() => void decide("cancelled")}>
                <X size={15} /> Agora não
              </button>
              {waiting && <small>Aguardando a MAVI terminar…</small>}
            </>
          )
        ) : (
          state === "confirmed" && (
            <a className="mavi-action-link" href={link}>
              <ExternalLink size={14} /> {a.scope === "client" ? "Abrir a Marca do cliente" : "Abrir em Identidades"}
              {result?.version ? ` (versão ${result.version})` : ""}
            </a>
          )
        )}
      </footer>
    </section>
  );
}
