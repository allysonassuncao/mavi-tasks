import { useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  CalendarDays,
  ChevronRight,
  FolderKanban,
  Pencil,
  Plus,
  Search,
  UsersRound,
} from "lucide-react";
import { Button, Input } from "./ui";
import { Empty } from "./components";
import { Pagination, usePagination } from "./Pagination";
import type { Client, Contract, Project, Snapshot } from "./types";
import { contractParts, dateLabel, fold, initials } from "./domain";

/** The chain every screen follows: who pays, what they bought, how it's organised. */
export function HierarchyGuide() {
  const steps = [
    ["Cliente", "quem contrata a agência"],
    ["Produto contratado", "o que o cliente comprou"],
    ["Projeto", "opcional: campanha, lançamento"],
    ["Tarefas", "o trabalho do dia a dia"],
  ];
  return (
    <ol className="hierarchy-guide" aria-label="Como o trabalho é organizado">
      {steps.map(([title, hint], i) => (
        <li key={title}>
          {i > 0 && <ChevronRight size={15} aria-hidden="true" />}
          <span>
            <strong>{title}</strong>
            <small>{hint}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

type ClientStatus = "active" | "archived" | "all";
const statusOptions: [ClientStatus, string][] = [
  ["active", "Ativos"],
  ["archived", "Arquivados"],
  ["all", "Todos"],
];
const count = new Intl.NumberFormat("pt-BR");

export function ClientPortfolio({
  data,
  canManage,
  projectProgress,
  onEditClient,
  onArchiveClient,
  onEditContract,
  onEditProject,
  onAddContract,
  onAddProject,
  onNewTask,
  canCreateTask,
  onViewClient,
  onViewProject,
}: {
  data: Snapshot;
  canManage: boolean;
  projectProgress: (project: Project) => { done: number; total: number };
  onEditClient: (client: Client) => void;
  /** Archives (true) or restores (false) a client, after confirmation. */
  onArchiveClient: (client: Client, archived: boolean) => void;
  onEditContract: (contract: Contract) => void;
  onEditProject: (project: Project) => void;
  onAddContract: (clientId: string) => void;
  onAddProject: (contractId: string) => void;
  onNewTask: (contractId: string, projectId?: string) => void;
  /** Whether the viewer may create tasks in a contracted product. */
  canCreateTask: (contractId: string) => boolean;
  onViewClient: (clientId: string) => void;
  onViewProject: (projectId: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Archived clients (former clients) stay out of the way unless asked for.
  const [status, setStatus] = useState<ClientStatus>("active");
  const top = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => {
    const archived = data.clients.filter((c) => c.archived).length;
    return {
      active: data.clients.length - archived,
      archived,
      all: data.clients.length,
    };
  }, [data.clients]);
  const clients = useMemo(() => {
    const q = fold(query.trim());
    return data.clients
      .filter(
        (c) =>
          (status === "all" || c.archived === (status === "archived")) &&
          fold(c.name).includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [data.clients, query, status]);
  // Cards are large (products and projects inside): a dozen per page.
  const pages = usePagination(clients, 12, `${status}:${query}`);
  const teamsOf = (clientId: string) =>
    data.clientTeams
      .filter((ct) => ct.client_id === clientId)
      .map((ct) => data.teams.find((t) => t.id === ct.team_id)?.name)
      .filter(Boolean)
      .join(", ");
  return (
    <>
      <HierarchyGuide />
      <div className="section-top" ref={top}>
        <span>
          {(() => {
            const n = counts.active;
            const noun = n === 1 ? "cliente ativo" : "clientes ativos";
            return canManage
              ? `${count.format(n)} ${noun} no espaço`
              : `${count.format(n)} ${noun} das suas equipes`;
          })()}
        </span>
        <div
          className="drive-view portfolio-status"
          role="group"
          aria-label="Mostrar clientes"
        >
          {statusOptions.map(([key, label]) => (
            <button
              type="button"
              key={key}
              className={status === key ? "selected" : ""}
              aria-pressed={status === key}
              onClick={() => setStatus(key)}
            >
              {label} <small>{count.format(counts[key])}</small>
            </button>
          ))}
        </div>
        <span className="portfolio-search">
          <Input
            type="search"
            aria-label="Buscar cliente"
            placeholder="Buscar cliente"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            icon={Search}
          />
        </span>
      </div>
      <div className="portfolio">
        {pages.pageItems.map((client) => {
          // An archived client's products are usually archived with it:
          // they're listed too, as its history.
          const contracts = data.contracts.filter(
            (k) =>
              k.client_id === client.id && (client.archived || !k.archived),
          );
          // Nothing new is started for a former client.
          const open = !client.archived;
          const projectCount = data.projects.filter(
            (p) => !p.archived && contracts.some((k) => k.id === p.contract_id),
          ).length;
          const teams = teamsOf(client.id);
          return (
            <article
              className={`panel portfolio-client ${client.archived ? "archived" : ""}`}
              key={client.id}
            >
              <header className="portfolio-client-head">
                <span
                  className="client-logo"
                  style={{
                    background: client.color + "20",
                    color: client.color,
                  }}
                >
                  {initials(client.name)}
                </span>
                <div>
                  <h2>
                    {client.name}
                    {client.archived && (
                      <span className="archived-tag">Arquivado</span>
                    )}
                  </h2>
                  <p>
                    {contracts.length}{" "}
                    {contracts.length === 1 ? "produto" : "produtos"} ·{" "}
                    {projectCount} {projectCount === 1 ? "projeto" : "projetos"}
                    {client.email && <> · {client.email}</>}
                  </p>
                  <span className="portfolio-teams">
                    <UsersRound size={13} /> {teams || "Sem equipe responsável"}
                  </span>
                </div>
                <div className="portfolio-actions">
                  <Button
                    className="text-btn"
                    onClick={() => onViewClient(client.id)}
                  >
                    Ver tarefas <ArrowUpRight size={15} />
                  </Button>
                  {canManage && (
                    <>
                      <Button
                        className="icon-btn"
                        aria-label={`Editar ${client.name}`}
                        title="Editar cliente"
                        onClick={() => onEditClient(client)}
                      >
                        <Pencil size={15} />
                      </Button>
                      <Button
                        className="icon-btn"
                        aria-label={`${open ? "Arquivar" : "Desarquivar"} ${client.name}`}
                        title={
                          open ? "Arquivar cliente" : "Desarquivar cliente"
                        }
                        onClick={() => {
                          const ok = window.confirm(
                            open
                              ? `Arquivar ${client.name}?\n\nO cliente sai da carteira ativa e não recebe novos produtos, projetos nem tarefas. Produtos, projetos, tarefas e arquivos continuam guardados, e você pode desarquivá-lo depois.`
                              : `Desarquivar ${client.name}?\n\nO cliente volta para a carteira ativa e pode receber novos produtos, projetos e tarefas.`,
                          );
                          if (ok) onArchiveClient(client, open);
                        }}
                      >
                        {open ? (
                          <Archive size={15} />
                        ) : (
                          <ArchiveRestore size={15} />
                        )}
                      </Button>
                      {open && (
                        <Button
                          className="btn secondary"
                          onClick={() => onAddContract(client.id)}
                        >
                          <Plus size={15} /> Produto
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </header>
              {contracts.length ? (
                <ul className="portfolio-products">
                  {contracts.map((contract) => {
                    const { product, detail } = contractParts(
                      data,
                      contract.id,
                    );
                    const projects = data.projects.filter(
                      (p) => p.contract_id === contract.id && !p.archived,
                    );
                    return (
                      <li className="portfolio-product" key={contract.id}>
                        <div className="portfolio-product-head">
                          <span
                            className="product-dot"
                            style={{ background: product?.color }}
                          />
                          <div>
                            <strong>
                              {product?.name}
                              {detail && <small> · {detail}</small>}
                              {contract.archived && (
                                <span className="archived-tag">Arquivado</span>
                              )}
                            </strong>
                          </div>
                          <div className="portfolio-actions">
                            {open && canCreateTask(contract.id) && (
                              <Button
                                className="text-btn"
                                onClick={() => onNewTask(contract.id)}
                              >
                                <Plus size={14} /> Tarefa
                              </Button>
                            )}
                            {canManage && (
                              <>
                                {open && !contract.archived && (
                                  <Button
                                    className="text-btn"
                                    onClick={() => onAddProject(contract.id)}
                                  >
                                    <Plus size={14} /> Projeto
                                  </Button>
                                )}
                                <Button
                                  className="icon-btn"
                                  aria-label={`Editar ${product?.name} de ${client.name}`}
                                  title="Editar produto do cliente"
                                  onClick={() => onEditContract(contract)}
                                >
                                  <Pencil size={14} />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                        {projects.length ? (
                          <ul className="portfolio-projects">
                            {projects.map((project) => {
                              const { done, total } = projectProgress(project);
                              return (
                                <li key={project.id}>
                                  <FolderKanban size={16} aria-hidden="true" />
                                  <button
                                    type="button"
                                    className="portfolio-project-name"
                                    onClick={() => onViewProject(project.id)}
                                  >
                                    {project.name}
                                  </button>
                                  <span className="portfolio-meta">
                                    <CalendarDays size={13} />
                                    {project.due_date
                                      ? dateLabel(project.due_date)
                                      : "Sem prazo"}
                                  </span>
                                  <span
                                    className="portfolio-meta portfolio-progress"
                                    title={`${done} de ${total} tarefas entregues no período`}
                                  >
                                    <progress value={done} max={total || 1} />
                                    {done}/{total}
                                  </span>
                                  <span className="portfolio-row-actions">
                                    {open && canCreateTask(contract.id) && (
                                      <Button
                                        className="icon-btn"
                                        aria-label={`Nova tarefa em ${project.name}`}
                                        title="Nova tarefa neste projeto"
                                        onClick={() =>
                                          onNewTask(contract.id, project.id)
                                        }
                                      >
                                        <Plus size={14} />
                                      </Button>
                                    )}
                                    {canManage && (
                                      <Button
                                        className="icon-btn"
                                        aria-label={`Editar ${project.name}`}
                                        title="Editar projeto"
                                        onClick={() => onEditProject(project)}
                                      >
                                        <Pencil size={14} />
                                      </Button>
                                    )}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <p className="portfolio-empty">
                            {open
                              ? "Sem projetos: as tarefas deste produto ficam avulsas."
                              : "Sem projetos."}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : !open ? (
                <div className="portfolio-empty-client">
                  <p>Nenhum produto registrado para este cliente.</p>
                </div>
              ) : (
                <div className="portfolio-empty-client">
                  <p>
                    Nenhum produto contratado ainda. Adicione o que este cliente
                    comprou para começar a criar projetos e tarefas.
                  </p>
                  {canManage && (
                    <Button
                      className="btn secondary"
                      onClick={() => onAddContract(client.id)}
                    >
                      <Plus size={15} /> Adicionar produto
                    </Button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      <Pagination
        className="portfolio-pagination"
        page={pages.page}
        pageCount={pages.pageCount}
        pageSize={pages.pageSize}
        total={clients.length}
        noun={clients.length === 1 ? "cliente" : "clientes"}
        onPage={pages.setPage}
        anchor={top}
      />
      {!clients.length && (
        <Empty
          title={
            query
              ? "Nenhum cliente encontrado"
              : status === "archived"
                ? "Nenhum cliente arquivado"
                : canManage
                  ? "Seu primeiro cliente começa aqui"
                  : "Nenhum cliente para você ainda"
          }
          body={
            query
              ? status === "all"
                ? "Confira a grafia ou limpe a busca."
                : "Confira a grafia, limpe a busca ou procure em Todos."
              : status === "archived"
                ? "Os clientes arquivados aparecem aqui."
                : canManage
                  ? "Cadastre um cliente e adicione os produtos que ele contratou."
                  : "Aqui aparecem os clientes atendidos pelas equipes em que você está. Peça a um gestor para incluí-lo em uma equipe."
          }
        />
      )}
    </>
  );
}
