import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowRight, Lightbulb, Sparkles } from "lucide-react";
import type { InsightBadge } from "./campaign-insights";
import { TONE_LABELS, type DailyRead } from "./campaign-daily";

const PRIORITY: Record<string, string> = { high: "Fazer hoje", medium: "Nesta semana", low: "Quando der" };

/** "hoje às 7:24", "ontem às 7:30", "02/10 às 7:10". */
function whenRead(day: string | null, at: string | null, today: string) {
  if (!day) return "";
  const time = at
    ? ` às ${new Date(at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
    : "";
  if (day === today) return `hoje${time}`;
  const [y, m, d] = day.split("-");
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (day === yesterday.toISOString().slice(0, 10)) return `ontem${time}`;
  return `${d}/${m}${y === today.slice(0, 4) ? "" : `/${y}`}${time}`;
}

/**
 * A coluna MAVI da lista de Campanhas: o ícone com a cor do momento da
 * campanha (a Leitura do dia) e o número de insights abertos. Passar o mouse
 * mostra a frase; o clique abre a leitura inteira, os insights que pedem ação
 * e o atalho para a aba Insights.
 */
export function CampaignMaviCell({
  read,
  badge,
  today,
  onOpen,
}: {
  read: DailyRead | undefined;
  badge: InsightBadge | undefined;
  today: string;
  /** Abre a campanha (na aba Insights, quando há insights abertos). */
  onOpen: (insights: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const headline = read?.headline || "";
  const openCount = badge?.open ?? 0;
  if (!headline && !openCount) {
    if (read?.pending || badge?.running)
      return (
        <span className="mavi-cell-pending" title="A MAVI está lendo esta campanha">
          <span className="insights-pulse" aria-hidden="true" /> Lendo
        </span>
      );
    return <span className="cell-note">—</span>;
  }
  const tone = read?.tone ?? null;
  const when = whenRead(read?.day ?? null, read?.at ?? null, today);
  const label = headline
    ? `Leitura da MAVI${tone ? ` (${TONE_LABELS[tone]})` : ""}: ${headline}`
    : `${openCount} ${openCount === 1 ? "insight aberto" : "insights abertos"}`;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`mavi-cell${tone ? ` ${tone}` : ""}`}
          title={headline ? `${headline}${when ? ` (${when})` : ""}` : "Ver os insights da MAVI"}
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Sparkles size={14} aria-hidden="true" />
          {openCount > 0 && (
            <span className={`mavi-cell-count${badge?.high ? " high" : ""}`}>{openCount}</span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="mavi-read"
          side="left"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          // Os cliques aqui não abrem a campanha da linha (o React sobe pelo portal).
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <header>
            <span className="mavi-read-title">
              <Sparkles size={14} aria-hidden="true" /> Leitura da MAVI
            </span>
            {tone && <span className={`mavi-read-tone ${tone}`}>{TONE_LABELS[tone]}</span>}
          </header>
          {headline ? (
            <>
              <p className="mavi-read-headline">{headline}</p>
              {read!.points.length > 0 && (
                <ul className="mavi-read-points">
                  {read!.points.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
              <p className="mavi-read-meta">
                {when && <>Lida {when}</>}
                {read!.money_basis && <> · valores {read!.money_basis === "gross" ? "com M" : "sem M"}</>}
                {read!.source === "rule" && <> · pelos números do MAVI</>}
                {read!.pending && <> · a de hoje está a caminho</>}
              </p>
            </>
          ) : (
            <p className="mavi-read-meta">
              {read?.pending ? "A leitura de hoje está a caminho." : "Ainda sem a leitura do dia desta campanha."}
            </p>
          )}
          {openCount > 0 && (
            <section className="mavi-read-insights" aria-label="Insights abertos">
              <h4>
                <Lightbulb size={13} aria-hidden="true" /> {openCount}{" "}
                {openCount === 1 ? "insight aberto" : "insights abertos"}
              </h4>
              {(read?.insights ?? []).length > 0 && (
                <ul>
                  {read!.insights.map((i, n) => (
                    <li key={n}>
                      <span className={`mavi-read-prio ${i.priority}`}>{PRIORITY[i.priority]}</span>
                      {i.title}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <button
            type="button"
            className="mavi-read-open"
            onClick={() => {
              setOpen(false);
              onOpen(openCount > 0);
            }}
          >
            {openCount > 0 ? "Ver os insights" : "Abrir a campanha"} <ArrowRight size={14} aria-hidden="true" />
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
