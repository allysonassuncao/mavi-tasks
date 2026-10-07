import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { CsEngine } from "./cs-engine";
import type { DdParams } from "./cs-drilldowns";
import type { HsSuggestions } from "./cs-dashboard";

/** O que as telas do painel de CS compartilham (CsDashboard.tsx). */
export type CsCtx = {
  e: CsEngine;
  /** Abre a janela de detalhe de um número. */
  drill: (metrica: string, params: DdParams, title?: string) => void;
  /** Abre o perfil do cliente de CS. */
  profile: (client: string) => void;
  color: (squad: string | null | undefined) => string;
  /** As sugestões de Health Score da MAVI no mês do painel (nulo: sem acesso, ou no link). */
  hs: HsSuggestions | null;
  /** "Pedir sugestões agora" (administradores e gestores). */
  requestHs: (() => Promise<void>) | null;
};
export const CsContext = createContext<CsCtx | null>(null);
export const useCs = () => useContext(CsContext)!;

/** A cor de um status, adimplência ou faixa de HS. */
export const csPill = (v: string | null | undefined) =>
  v === "PAGO" || v === "ADIMPLENTE" || v === "SATISFEITO" ? "good"
    : v === "PERDA" || v === "CRITICO" ? "bad"
      : v === "PENDENTE" || v === "PARCIAL" || v === "INADIMPLENTE" || v === "ALERTA" ? "warn" : "";

/** O "i" com o "como calculamos". */
export function Info({ text }: { text: string }) {
  return <span className="cs-info" tabIndex={0} role="note" aria-label={`Como calculamos: ${text}`} data-help={text}>i</span>;
}

/** O botão "ver"/"explorar" que abre o detalhe. */
export function Dd({ m, p, label = "ver", title }: { m: string; p: DdParams; label?: ReactNode; title?: string }) {
  const { drill } = useCs();
  return (
    <button type="button" className="cs-dd-btn" onClick={() => drill(m, p, title)}>
      {label}
    </button>
  );
}

/** Uma linha que abre o perfil do cliente (clique ou Enter). */
export function useProfileRow() {
  const { profile } = useCs();
  return useCallback((id: string | null | undefined) =>
    id ? { className: "cs-row-link", tabIndex: 0, onClick: () => profile(id),
      onKeyDown: (ev: { key: string }) => ev.key === "Enter" && profile(id) } : {}, [profile]);
}
