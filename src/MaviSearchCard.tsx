import { ArrowRight, GraduationCap, Search } from "lucide-react";
import { navigate, pageUrl, routeParts } from "./router";
import type { SearchArtifact, TutorialArtifact } from "./mavi-artifacts";
import "./mavi-artifacts.css";

/**
 * O botão "Ver na Busca avançada" da busca de tarefas da MAVI (find_tasks),
 * na bolinha e no módulo MAVI: abre a página da Busca com os mesmos termos,
 * assunto e filtros, para ver a lista inteira, agrupar e editar em massa.
 */
/** A Busca avançada da agência aberta com esta busca. */
export function searchCardUrl(query: string, path = window.location.pathname) {
  return `${pageUrl("search", routeParts(path).company)}?${query}`;
}

export function SearchCard({ artifact }: { artifact: SearchArtifact }) {
  const url = searchCardUrl(artifact.query);
  const total =
    artifact.total === 1
      ? "1 tarefa encontrada"
      : artifact.total
        ? `${artifact.total} tarefas encontradas`
        : "Nenhuma tarefa encontrada";
  return (
    <a
      className="mavi-search-card"
      href={url}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(url);
      }}
    >
      <Search size={16} aria-hidden="true" />
      <span>
        <strong>Ver na Busca avançada</strong>
        <small>
          {total} · “{artifact.request}”
        </small>
      </span>
      <ArrowRight size={15} aria-hidden="true" />
    </a>
  );
}

/** O tutorial da agência aberto na seção (?tutorial=<id>#secao). */
export function tutorialCardUrl(
  artifact: Pick<TutorialArtifact, "tutorial" | "anchor">,
  path = window.location.pathname,
) {
  return `${pageUrl("tutorials", routeParts(path).company)}?tutorial=${artifact.tutorial}${artifact.anchor ? `#${artifact.anchor}` : ""}`;
}

/**
 * O cartão "Abrir tutorial" da MAVI (search_tutorials): o tutorial que
 * respondeu à dúvida, aberto na seção.
 */
export function TutorialCard({ artifact }: { artifact: TutorialArtifact }) {
  const url = tutorialCardUrl(artifact);
  return (
    <a
      className="mavi-search-card mavi-tutorial-card"
      href={url}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(url);
      }}
    >
      <GraduationCap size={16} aria-hidden="true" />
      <span>
        <strong>Abrir tutorial: {artifact.title}</strong>
        <small>
          {artifact.section ? `Seção “${artifact.section}”` : artifact.summary || "Do começo"}
        </small>
      </span>
      <ArrowRight size={15} aria-hidden="true" />
    </a>
  );
}
