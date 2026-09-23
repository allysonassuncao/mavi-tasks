import { useState } from "react";
import {
  ArrowUpDown,
  CalendarDays,
  ChevronRight,
  Folder,
  FolderKanban,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button, Input, Select, SelectOption } from "./ui";
import { Empty } from "./components";
import type { Project, Snapshot } from "./types";
import {
  contractParts,
  contractProductLabel,
  dateLabel,
  fold,
  projectReview,
} from "./domain";

type View = "folders" | "list";
type Due = "" | "late" | "week" | "none";
type Sort = "due" | "name" | "client";
const VIEW_KEY = "mavi:projects-view";
function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "folders";
  } catch {
    return "folders";
  }
}
function rememberView(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Remembering the layout is a convenience; ignore blocked storage.
  }
}
function addDays(day: string, days: number) {
  const d = new Date(day + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Projects browsed like a drive: clients and their contracted products are
 * folders, projects are the files inside. Filters narrow every level; a
 * search looks across all folders at once.
 */
export function ProjectsBrowser({
  data,
  today,
  canManage,
  projectProgress,
  onEditProject,
  onViewProject,
  onNewTask,
  canCreateTask,
  onNewProject,
}: {
  data: Snapshot;
  today: string;
  canManage: boolean;
  projectProgress: (project: Project) => { done: number; total: number };
  onEditProject: (project: Project) => void;
  onViewProject: (projectId: string) => void;
  onNewTask: (contractId: string, projectId: string) => void;
  /** Whether the viewer may create tasks in a contracted product. */
  canCreateTask: (contractId: string) => boolean;
  onNewProject: (contractId?: string) => void;
}) {
  const [view, setView] = useState<View>(readView);
  const [folder, setFolder] = useState<{ client?: string; contract?: string }>(
    {},
  );
  const [query, setQuery] = useState("");
  const [client, setClient] = useState("");
  const [product, setProduct] = useState("");
  const [team, setTeam] = useState("");
  const [due, setDue] = useState<Due>("");
  const [sort, setSort] = useState<Sort>("due");
  const filtering = !!(client || product || team || due);
  const searching = query.trim().length > 0;

  const isLate = (p: Project) => !!p.due_date && p.due_date < today;
  const matches = (p: Project) => {
    const {
      contract,
      client: c,
      product: pr,
    } = contractParts(data, p.contract_id);
    if (!contract || contract.archived) return false;
    if (client && c?.id !== client) return false;
    if (product && pr?.id !== product) return false;
    if (
      team &&
      !data.clientTeams.some(
        (ct) => ct.client_id === c?.id && ct.team_id === team,
      )
    )
      return false;
    if (due === "late" && !isLate(p)) return false;
    if (
      due === "week" &&
      !(p.due_date && p.due_date >= today && p.due_date <= addDays(today, 7))
    )
      return false;
    if (due === "none" && p.due_date) return false;
    if (searching) {
      const q = fold(query.trim());
      const haystack = [p.name, c?.name ?? "", pr?.name ?? ""].map(fold);
      if (!haystack.some((h) => h.includes(q))) return false;
    }
    return true;
  };
  const projects = data.projects.filter((p) => !p.archived && matches(p));
  const contractsOf = (clientId: string) =>
    data.contracts.filter((k) => k.client_id === clientId && !k.archived);
  const projectsIn = (contractId: string) =>
    projects.filter((p) => p.contract_id === contractId);

  function sorted(list: Project[]) {
    const clientName = (p: Project) =>
      contractParts(data, p.contract_id).client?.name ?? "";
    return [...list].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "pt-BR")
        : sort === "client"
          ? clientName(a).localeCompare(clientName(b), "pt-BR") ||
            a.name.localeCompare(b.name, "pt-BR")
          : (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"),
    );
  }
  function changeView(next: View) {
    setView(next);
    rememberView(next);
  }
  function clearFilters() {
    if (client) setFolder({});
    setClient("");
    setProduct("");
    setTeam("");
    setDue("");
    setQuery("");
  }

  const folderClient = data.clients.find((c) => c.id === folder.client);
  const folderContract = folder.contract
    ? contractParts(data, folder.contract)
    : null;

  const reviewBadge = (p: Project) => {
    const review = projectReview(p);
    return (
      <span
        className={`review-badge ${review.required ? "" : "off"}`}
        title="Validação das tarefas deste projeto"
      >
        <ShieldCheck size={12} aria-hidden="true" />
        {!review.required
          ? "Sem validação"
          : review.approver === "supervisor"
            ? "Valida: supervisor"
            : "Valida: criador"}
      </span>
    );
  };
  const dueBadge = (p: Project) => (
    <span className={`drive-due ${isLate(p) ? "late" : ""}`}>
      <CalendarDays size={13} />
      {p.due_date ? dateLabel(p.due_date) : "Sem prazo"}
      {isLate(p) && " · atrasado"}
    </span>
  );
  const projectActions = (p: Project) => (
    <span className="drive-actions">
      {canCreateTask(p.contract_id) && (
        <Button
          className="icon-btn"
          aria-label={`Nova tarefa em ${p.name}`}
          title="Nova tarefa neste projeto"
          onClick={() => onNewTask(p.contract_id, p.id)}
        >
          <Plus size={15} />
        </Button>
      )}
      {canManage && (
        <Button
          className="icon-btn"
          aria-label={`Editar ${p.name}`}
          title="Editar projeto"
          onClick={() => onEditProject(p)}
        >
          <Pencil size={14} />
        </Button>
      )}
    </span>
  );
  const projectCard = (p: Project, showPath: boolean) => {
    const { client: c, product: pr } = contractParts(data, p.contract_id);
    const { done, total } = projectProgress(p);
    return (
      <article className="drive-file" key={p.id}>
        <div className="drive-file-top">
          <span className="drive-file-icon">
            <FolderKanban size={20} />
          </span>
          {projectActions(p)}
        </div>
        <button
          type="button"
          className="drive-file-name"
          onClick={() => onViewProject(p.id)}
          title="Ver tarefas do projeto"
        >
          {p.name}
        </button>
        {showPath ? (
          <p className="drive-path">
            {c?.name} <ChevronRight size={12} aria-hidden="true" />{" "}
            <span className="product-dot" style={{ background: pr?.color }} />{" "}
            {contractProductLabel(data, p.contract_id)}
          </p>
        ) : null}
        <div className="drive-progress" title="Tarefas entregues no período">
          <progress value={done} max={total || 1} />
          <span>
            {done}/{total}
          </span>
        </div>
        <div className="drive-file-meta">
          {dueBadge(p)}
          {reviewBadge(p)}
        </div>
      </article>
    );
  };
  const folderCard = (
    key: string,
    title: string,
    color: string | undefined,
    meta: string,
    late: number,
    open: () => void,
  ) => (
    <button type="button" className="drive-folder" key={key} onClick={open}>
      <Folder
        size={22}
        style={{ color: color ?? "#9eb975" }}
        fill="currentColor"
        fillOpacity={0.18}
      />
      <span>
        <strong>{title}</strong>
        <small>
          {meta}
          {late > 0 && <em> · {late} atrasado(s)</em>}
        </small>
      </span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );

  function folderBody() {
    if (folderContract?.contract) {
      const list = sorted(projectsIn(folderContract.contract.id));
      return list.length ? (
        <div className="drive-grid">
          {list.map((p) => projectCard(p, false))}
        </div>
      ) : (
        <Empty
          title={filtering ? "Nenhum projeto com esses filtros" : "Pasta vazia"}
          body={
            filtering
              ? "Ajuste ou limpe os filtros."
              : "Crie um projeto para organizar as entregas deste produto, como uma campanha ou um lançamento."
          }
          action={
            canManage && !filtering ? (
              <Button
                className="btn primary"
                onClick={() => onNewProject(folderContract.contract!.id)}
              >
                <Plus size={16} /> Novo projeto aqui
              </Button>
            ) : undefined
          }
        />
      );
    }
    if (folderClient) {
      const contracts = contractsOf(folderClient.id).filter(
        (k) => !filtering || projectsIn(k.id).length,
      );
      return contracts.length ? (
        <div className="drive-folders">
          {contracts.map((k) => {
            const list = projectsIn(k.id);
            const pr = contractParts(data, k.id).product;
            return folderCard(
              k.id,
              contractProductLabel(data, k.id),
              pr?.color,
              `${list.length} ${list.length === 1 ? "projeto" : "projetos"}`,
              list.filter(isLate).length,
              () => setFolder({ client: folderClient.id, contract: k.id }),
            );
          })}
        </div>
      ) : (
        <Empty
          title="Nenhum produto com esses filtros"
          body="Ajuste ou limpe os filtros."
        />
      );
    }
    const clients = data.clients.filter((c) => {
      if (c.archived || !contractsOf(c.id).length) return false;
      return (
        !filtering ||
        projects.some(
          (p) => contractParts(data, p.contract_id).client?.id === c.id,
        )
      );
    });
    return clients.length ? (
      <div className="drive-folders">
        {clients.map((c) => {
          const list = projects.filter(
            (p) => contractParts(data, p.contract_id).client?.id === c.id,
          );
          const products = contractsOf(c.id).length;
          return folderCard(
            c.id,
            c.name,
            c.color,
            `${products} ${products === 1 ? "produto" : "produtos"} · ${list.length} ${list.length === 1 ? "projeto" : "projetos"}`,
            list.filter(isLate).length,
            () => setFolder({ client: c.id }),
          );
        })}
      </div>
    ) : (
      <Empty
        title={
          filtering
            ? "Nenhum projeto com esses filtros"
            : "Nenhum projeto ainda"
        }
        body={
          filtering
            ? "Ajuste ou limpe os filtros."
            : canManage
              ? "Adicione produtos aos clientes (em Clientes) para começar a organizar projetos."
              : "Aqui aparecem os projetos dos clientes atendidos pelas equipes em que você está."
        }
      />
    );
  }

  const sortHeader = (key: Sort, label: string) => (
    <button
      type="button"
      className={`drive-sort ${sort === key ? "active" : ""}`}
      onClick={() => setSort(key)}
      aria-pressed={sort === key}
    >
      {label} <ArrowUpDown size={12} aria-hidden="true" />
    </button>
  );
  function listBody() {
    const list = sorted(projects);
    if (!list.length)
      return (
        <Empty
          title={
            filtering || searching
              ? "Nenhum projeto encontrado"
              : "Nenhum projeto ainda"
          }
          body={
            filtering || searching
              ? "Ajuste a busca ou limpe os filtros."
              : canManage
                ? "Crie o primeiro projeto em Novo projeto."
                : "Aqui aparecem os projetos dos clientes atendidos pelas equipes em que você está."
          }
        />
      );
    return (
      <div className="panel drive-table-wrap">
        <table className="drive-table">
          <thead>
            <tr>
              <th>{sortHeader("name", "Projeto")}</th>
              <th className="hide-mobile">{sortHeader("client", "Cliente")}</th>
              <th className="hide-mobile">Produto</th>
              <th>{sortHeader("due", "Prazo")}</th>
              <th className="hide-mobile hide-narrow">Progresso</th>
              <th className="hide-mobile">Validação</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {list.map((p) => {
              const { client: c, product: pr } = contractParts(
                data,
                p.contract_id,
              );
              const { done, total } = projectProgress(p);
              return (
                <tr key={p.id}>
                  <td>
                    <span className="drive-row-name">
                      <FolderKanban size={16} aria-hidden="true" />
                      <button
                        type="button"
                        className="drive-file-name"
                        onClick={() => onViewProject(p.id)}
                      >
                        {p.name}
                      </button>
                    </span>
                    <small className="show-mobile">
                      {c?.name} · {pr?.name}
                    </small>
                  </td>
                  <td className="hide-mobile">
                    <button
                      type="button"
                      className="drive-link"
                      onClick={() => {
                        changeView("folders");
                        setFolder({ client: c?.id });
                      }}
                    >
                      {c?.name}
                    </button>
                  </td>
                  <td className="hide-mobile">
                    <span className="drive-product">
                      <span
                        className="product-dot"
                        style={{ background: pr?.color }}
                      />
                      {contractProductLabel(data, p.contract_id)}
                    </span>
                  </td>
                  <td>{dueBadge(p)}</td>
                  <td className="hide-mobile hide-narrow">
                    <span className="drive-progress">
                      <progress value={done} max={total || 1} />
                      <span>
                        {done}/{total}
                      </span>
                    </span>
                  </td>
                  <td className="hide-mobile">{reviewBadge(p)}</td>
                  <td>{projectActions(p)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="drive">
      <div className="drive-toolbar">
        <span className="drive-search">
          <Input
            type="search"
            aria-label="Buscar projeto"
            placeholder="Buscar projeto, cliente ou produto"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            icon={Search}
          />
        </span>
        <div className="drive-view" role="group" aria-label="Visualização">
          <button
            type="button"
            className={view === "folders" ? "selected" : ""}
            aria-pressed={view === "folders"}
            onClick={() => changeView("folders")}
          >
            <LayoutGrid size={15} /> Pastas
          </button>
          <button
            type="button"
            className={view === "list" ? "selected" : ""}
            aria-pressed={view === "list"}
            onClick={() => changeView("list")}
          >
            <List size={15} /> Lista
          </button>
        </div>
      </div>
      <div className="drive-filters">
        <Select
          aria-label="Filtrar por cliente"
          value={client}
          onValueChange={(id) => {
            setClient(id);
            // Picking a client opens its folder, like jumping to it in a drive.
            setFolder(id ? { client: id } : {});
          }}
        >
          <SelectOption value="">Todos os clientes</SelectOption>
          {data.clients
            .filter((c) => !c.archived)
            .map((c) => (
              <SelectOption key={c.id} value={c.id}>
                {c.name}
              </SelectOption>
            ))}
        </Select>
        <Select
          aria-label="Filtrar por produto"
          value={product}
          onValueChange={setProduct}
        >
          <SelectOption value="">Todos os produtos</SelectOption>
          {data.products.map((p) => (
            <SelectOption key={p.id} value={p.id}>
              {p.name}
            </SelectOption>
          ))}
        </Select>
        <Select
          aria-label="Filtrar por equipe"
          value={team}
          onValueChange={setTeam}
        >
          <SelectOption value="">Todas as equipes</SelectOption>
          {data.teams.map((t) => (
            <SelectOption key={t.id} value={t.id}>
              {t.name}
            </SelectOption>
          ))}
        </Select>
        <Select
          aria-label="Filtrar por prazo"
          value={due}
          onValueChange={(v) => setDue(v as Due)}
        >
          <SelectOption value="">Qualquer prazo</SelectOption>
          <SelectOption value="late">Atrasados</SelectOption>
          <SelectOption value="week">Vencem em 7 dias</SelectOption>
          <SelectOption value="none">Sem prazo</SelectOption>
        </Select>
        {(filtering || searching) && (
          <Button className="text-btn" onClick={clearFilters}>
            <X size={14} /> Limpar filtros
          </Button>
        )}
      </div>
      {view === "list" ? (
        listBody()
      ) : (
        <>
          <nav className="drive-breadcrumb" aria-label="Pasta atual">
            <button
              type="button"
              onClick={() => setFolder({})}
              aria-current={!folder.client ? "page" : undefined}
            >
              Projetos
            </button>
            {folderClient && !searching && (
              <>
                <ChevronRight size={15} aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => setFolder({ client: folderClient.id })}
                  aria-current={!folder.contract ? "page" : undefined}
                >
                  {folderClient.name}
                </button>
              </>
            )}
            {folderContract?.contract && !searching && (
              <>
                <ChevronRight size={15} aria-hidden="true" />
                <span aria-current="page">
                  {contractProductLabel(data, folderContract.contract.id)}
                </span>
              </>
            )}
            {searching && (
              <>
                <ChevronRight size={15} aria-hidden="true" />
                <span aria-current="page">Resultados da busca</span>
              </>
            )}
            {canManage && folderContract?.contract && !searching && (
              <Button
                className="btn secondary drive-new"
                onClick={() => onNewProject(folderContract.contract!.id)}
              >
                <Plus size={15} /> Novo projeto aqui
              </Button>
            )}
          </nav>
          {searching ? (
            projects.length ? (
              <div className="drive-grid">
                {sorted(projects).map((p) => projectCard(p, true))}
              </div>
            ) : (
              <Empty
                title="Nenhum projeto encontrado"
                body="Confira a grafia ou limpe a busca e os filtros."
              />
            )
          ) : (
            folderBody()
          )}
        </>
      )}
    </div>
  );
}
