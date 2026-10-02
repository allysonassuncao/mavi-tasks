import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { AiChat, AnswerText } from "./AiChat";
import { askAi, openAiSource } from "./ai";
import { CampaignAlertCard } from "./MaviCampaignAlertCard";
import type { AdCampaign } from "./campaigns";
import "./campaign-mavi.css";

/**
 * Campanhas › Conversar com a MAVI: a conversa fica fixa à direita da
 * campanha aberta. A MAVI consulta ao vivo a conta de anúncio (Meta Ads pela
 * conexão do Facebook da campanha, o botão Conectar; Google Ads pela conexão
 * da agência) e os números sincronizados do MAVI. Primeira versão: só consulta.
 * A conversa fica salva no histórico da MAVI.
 */

const SUGGESTIONS: Record<"meta" | "google", string[]> = {
  meta: [
    "Como está esta campanha nos últimos 7 dias?",
    "Quais anúncios estão com o custo por resultado mais alto?",
    "Algum conjunto está gastando sem trazer resultado?",
    "O que você mudaria para bater a meta do ciclo?",
  ],
  google: [
    "Como está esta campanha nos últimos 7 dias?",
    "Quais termos de pesquisa gastaram sem converter?",
    "Quais palavras-chave têm o melhor custo por conversão?",
    "O que você mudaria para bater a meta do ciclo?",
  ],
};

export function CampaignMavi({
  company,
  campaign,
  client,
  clientName,
  demo,
  notify,
  onClose,
}: {
  company: string;
  campaign: AdCampaign;
  client: string | null;
  clientName: string;
  demo: boolean;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const live = campaign.platform === "meta" || campaign.platform === "google";
  // A conversa fica salva (aparece também no histórico da MAVI).
  const conversation = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  useEffect(() => {
    document.body.classList.add("campaign-mavi-open");
    return () => document.body.classList.remove("campaign-mavi-open");
  }, []);

  return (
    <aside className="panel campaign-mavi" aria-label="Conversar com a MAVI sobre a campanha">
      <header>
        <Sparkles size={18} aria-hidden="true" />
        <div>
          <strong>Conversar com a MAVI</strong>
          <small>
            {campaign.name}
            {clientName ? ` · ${clientName}` : ""}
          </small>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar a conversa" title="Fechar">
          <X size={16} />
        </button>
      </header>
      {campaign.platform === "meta" && (
        <p className="campaign-mavi-note">
          Meta Ads ao vivo pela conexão do Facebook desta campanha (o botão Conectar). A MAVI só consulta.
        </p>
      )}
      {campaign.platform === "google" && (
        <p className="campaign-mavi-note">Google Ads ao vivo pela conexão da agência (MCC). A MAVI só consulta.</p>
      )}
      <AiChat
        intro={
          live
            ? "Pergunte sobre esta campanha. A MAVI cruza os números do ciclo (verba, meta e M) com a conta de anúncio ao vivo e mostra de onde tirou cada número. Nesta versão ela analisa e sugere; não pausa nem muda orçamento."
            : "Pergunte sobre esta campanha. A MAVI usa os números do ciclo registrados no MAVI (esta plataforma não tem consulta ao vivo)."
        }
        placeholder="Pergunte sobre esta campanha"
        suggestions={SUGGESTIONS[campaign.platform === "google" ? "google" : "meta"]}
        readOnly={demo}
        readOnlyNote="Na demonstração, a conversa com a MAVI fica desligada."
        send={(q, _history, handlers, extra) =>
          askAi(
            company,
            {
              ...(client ? { client } : {}),
              contract: campaign.contract_id,
              module: "campaigns",
              campaign: campaign.id,
            },
            q,
            conversation.current,
            handlers,
            extra?.signal,
          )
        }
        onRun={(r) => {
          conversation.current = r.conversation;
          setConversationId(r.conversation);
        }}
        onAnswer={(a) => {
          conversation.current = a.conversation ?? conversation.current;
          setConversationId(conversation.current);
        }}
        renderAnswer={(text, sources, _typing, below) => (
          <AnswerText text={text} sources={sources} onSource={openAiSource} below={below} />
        )}
        renderAction={(artifact, busy) => (
          <CampaignAlertCard
            artifact={artifact}
            host={{ company, conversation: conversationId, readOnly: demo, streaming: busy, notify }}
          />
        )}
      />
    </aside>
  );
}
