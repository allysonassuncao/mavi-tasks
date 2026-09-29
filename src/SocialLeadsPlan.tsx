import { useSlModule } from "./social-leads-module";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  FileJson,
  History,
  Link2,
  CalendarClock,
  FileText,
  Hammer,
  Image as ImageIcon,
  Lock,
  Megaphone,
  MapPin,
  MessageCircle,
  MessageSquare,
  Target,
  Users,
  Wallet,
  Eye,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Lightbulb,
  Presentation,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { Empty, Modal } from "./components";
import { PublicSocialLeads } from "./PublicSocialLeads";
import {
  Button,
  Checkbox,
  Input,
  Loading,
  Select,
  SelectOption,
  Textarea,
} from "./ui";
import { statuses, type Snapshot, type Status } from "./types";
import { navigate, routeParts, useUrlState } from "./router";
import {
  monthFolder,
  serverLink,
  type ReleaseAssign,
  type ReleaseCycle,
  shareUrl,
  useLiveSocialLeads,
  type PlanBundle,
  type SocialLeadsBackend,
} from "./social-leads-api";
import {
  complianceFlags,
  formatUsd,
  usageSummary,
  editPost,
  fullContent,
  parseImport,
  pillars,
  relativeDays,
  slugify,
  stages,
  type Decision,
  type Pillar,
  type PlanContent,
  type PlanPost,
  type PortfolioItem,
  type SlBriefing,
  type SlJob,
  type SlPlan,
  type SlPost,
  type MediaFile,
  type SlTask,
  type SlPostEvent,
  describeEvent,
  maviText,
  campaignFacts,
  leadOf,
  pointsOf,
  postTextPlain,
  flagText,
  clampPosts,
  type SlAlertRead,
  type CampaignObjective,
} from "./social-leads";
import {
  MediaInput,
  PostCountInput,
  type Uploading,
} from "./SocialLeadsFields";
import { RichTextContent } from "./RichTextContent";
import { parseDescription, serializeDescription } from "./rich-text";
import "./social-leads-onboarding.css";

const RichTextEditor = lazy(() => import("./RichTextEditor"));

/** A place in the app, inside the current company (/agencias/<slug>/…). */
const appPath = (path: string) => {
  const company = routeParts(window.location.pathname).company;
  return (company ? `/agencias/${company}` : "") + path;
};

/** Why the plan was opened from the portfolio. */
export type PlanIntent = "share" | "next-month" | "release" | "campaign" | null;
/** Who produces the arts and in how many days (the module's settings). */
export type Production = {
  /** The creative team (or the squad): the default receiver of the arts. */
  teamId: string | null;
  teamName: string | null;
  artDays: number;
};

const dateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
const date = (iso: string) => new Date(iso).toLocaleDateString("pt-BR");
/** Longer than any generation can run (300 s on Vercel); keep in step with
 * mavi_private.social_leads_expire_jobs, which closes it a minute sooner. */
const STUCK_JOB_MS = 7 * 60_000;
const STUCK_JOB_ERROR =
  "A geração foi interrompida antes de terminar e não voltou. Tente de novo.";
const decisionLabel: Record<Decision, string> = {
  pending: "Pendente",
  approved: "Aprovado",
  rejected: "Ajuste pedido",
};

export function PlanView({
  item,
  isLeader,
  production,
  clientName,
  briefing,
  plans,
  plan,
  job,
  company,
  user,
  data,
  backend,
  demo = false,
  intent,
  clearIntent,
  onOpenBriefing,
  onChanged,
  onMonth,
  notify,
}: {
  item: PortfolioItem;
  isLeader: boolean;
  /** Demo mode (the editor keeps images in memory). */
  demo?: boolean;
  production: Production;
  clientName: string;
  briefing: SlBriefing | null;
  plans: SlPlan[];
  plan: SlPlan | null;
  job: SlJob | null;
  company: string;
  user: string;
  data: Snapshot;
  backend: SocialLeadsBackend;
  intent: PlanIntent;
  clearIntent: () => void;
  onOpenBriefing: () => void;
  onChanged: () => void;
  onMonth: (n: number) => void;
  notify: (m: string) => void;
}) {
  const mod = useSlModule();
  const [bundle, setBundle] = useState<PlanBundle | null>(null);
  const [error, setError] = useState("");
  const [section, setSection] = useState<
    "posts" | "estrategia" | "campanha" | "alertas" | "versoes"
  >("posts");
  const [openPost, setOpenPost] = useState<number | null>(null);
  // ?post=N (the "Abrir o post no plano" of an art task) opens that post once.
  const [linkedPost, setLinkedPost] = useUrlState<number>("post", 0);
  const [modal, setModal] = useState<
    | null
    | "share"
    | "regenerate"
    | "next-month"
    | "import"
    | "release"
    | "campaign"
    | "pdf"
  >(null);
  const [preview, setPreview] = useState<null | {
    text: string;
    reason: string;
    source: "import" | "ai";
  }>(null);
  const [busy, setBusy] = useState("");
  // How many posts the next generation writes (the plan's own, by default).
  const [count, setCount] = useState<number | null>(null);
  const previous = useRef<SlPost[] | null>(null);

  const load = useCallback(() => {
    if (!plan) {
      setBundle(null);
      return;
    }
    backend
      .plan(plan.id)
      .then((b) => {
        // A decision the client made on the link while the page is open.
        const before = previous.current;
        if (before && before[0]?.plan_id === b.plan.id)
          for (const p of b.posts) {
            const o = before.find((x) => x.number === p.number);
            if (
              p.decided_via === "link" &&
              p.decided_at &&
              p.decided_at !== o?.decided_at
            )
              notify(
                p.decision === "approved"
                  ? `O cliente aprovou o post ${p.number}.`
                  : `O cliente pediu ajuste no post ${p.number}.`,
              );
          }
        previous.current = b.posts;
        setBundle(b);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  }, [backend, plan?.id, plan?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  useLiveSocialLeads(item.contract_id, load);
  useEffect(() => {
    if (!linkedPost || !bundle || bundle.plan.id !== plan?.id) return;
    if (bundle.posts.some((p) => p.number === linkedPost)) {
      setSection("posts");
      setOpenPost(linkedPost);
    }
    setLinkedPost(0);
  }, [linkedPost, bundle, plan?.id, setLinkedPost]);

  useEffect(() => {
    if (!intent) return;
    if (intent === "share" && plan) setModal("share");
    if (intent === "next-month") setModal("next-month");
    if (intent === "release" && plan) setModal("release");
    if (intent === "campaign" && plan) {
      if (item.campaign?.id)
        navigate(appPath(`/campanhas?campanha=${item.campaign.id}`));
      else setModal("campaign");
    }
    clearIntent();
  }, [intent, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  // A generation the server stopped mid-way never reports back: past the
  // limit it shows as failed (the database closes it a minute before).
  const [now, setNow] = useState(() => Date.now());
  const age = job ? now - new Date(job.created_at).getTime() : 0;
  const stale = job?.status === "running" && age >= STUCK_JOB_MS;
  useEffect(() => {
    if (job?.status !== "running" || stale) return;
    const t = setTimeout(() => setNow(Date.now()), STUCK_JOB_MS - age + 1000);
    return () => clearTimeout(t);
  }, [job?.id, job?.status, stale]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = job?.status === "running" && !stale;
  const failed = stale
    ? { ...job, error: STUCK_JOB_ERROR }
    : job?.status === "failed" &&
        (!plan || new Date(job.created_at) > new Date(plan.updated_at))
      ? job
      : null;

  const generate = async (mode: "new" | "current", posts?: number) => {
    setBusy(mode);
    try {
      await backend.generate(
        company,
        item.contract_id,
        mode,
        mode === "current" ? plan?.id : undefined,
        posts,
      );
      notify(
        `A MAVI começou a escrever ${posts ? `os ${posts} posts do plano` : "o plano"}. Leva de 1 a 3 minutos.`,
      );
      setModal(null);
      onChanged();
      if (mode === "new") onMonth(0);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const jobBanner = running ? (
    <div className="sl-banner info" role="status">
      <RefreshCw size={16} className="spin" />
      <div>
        <strong>
          A MAVI está escrevendo{" "}
          {job?.kind === "current"
            ? `de novo o ${plan?.label}`
            : "o plano do próximo mês"}
          …
        </strong>
        <small>
          Leva de 1 a 3 minutos. Pode sair desta tela: o plano aparece aqui
          quando ficar pronto.
        </small>
      </div>
    </div>
  ) : failed ? (
    <div className="sl-banner bad" role="alert">
      <CircleAlert size={16} />
      <div>
        <strong>A geração do plano falhou</strong>
        <small>{failed.error}</small>
      </div>
      {item.can_write && (
        <Button
          className="btn secondary"
          loading={!!busy}
          onClick={() =>
            void generate(failed.kind === "current" && plan ? "current" : "new")
          }
        >
          Tentar de novo
        </Button>
      )}
    </div>
  ) : null;

  if (!plan)
    return (
      <div className="sl-plan">
        {jobBanner}
        {!running && (
          <Empty
            title="Nenhum plano ainda"
            body={
              briefing
                ? "Revise o briefing e gere o plano do Mês 1."
                : "Preencha o briefing: com ele a MAVI escreve o plano do Mês 1."
            }
            action={
              <Button className="btn primary" onClick={onOpenBriefing}>
                {briefing ? "Revisar e gerar" : "Começar o briefing"}
              </Button>
            }
          />
        )}
      </div>
    );
  if (error && !bundle)
    return <Empty title="Não foi possível abrir o plano" body={error} />;
  if (!bundle || bundle.plan.id !== plan.id) return <Loading compact />;

  const posts = bundle.posts;
  const content = fullContent(bundle.plan, posts);
  const approved = posts.filter((p) => p.decision === "approved").length;
  const rejected = posts.filter((p) => p.decision === "rejected").length;
  const total = posts.length;
  const allApproved = total > 0 && approved === total;
  const postCount = clampPosts(count ?? total);
  const reads = bundle.alertReads ?? [];
  const isLatest = plans.at(-1)?.id === plan.id;
  const flags = complianceFlags(content.posts);
  const cost = usageSummary(bundle.usage ?? []);
  const people = (id: string | null) =>
    data.members.find((m) => m.user_id === id)?.name;
  const stage = allApproved
    ? item.campaign?.active
      ? 4
      : 3
    : bundle.plan.share_enabled || approved + rejected
      ? 2
      : 1;
  // Production: approved posts still without an art task, arts sent.
  const toRelease = posts.filter(
    (p) => p.decision === "approved" && !p.task_id,
  ).length;
  const withTask = posts.filter((p) => p.task_id).length;
  const withArt = posts.filter((p) => p.arts?.length).length;
  const taskOf = (p: SlPost) => bundle.tasks.find((t) => t.id === p.task_id);

  const write = async (
    next: PlanContent,
    reason: string,
    source: "import" | "manual" | "ai",
    summary = "",
  ) => {
    await backend.writePlan(
      company,
      item.contract_id,
      plan.id,
      next,
      reason,
      bundle.plan.version,
      source,
      summary,
    );
    load();
    onChanged();
  };

  return (
    <div className="sl-plan">
      {jobBanner}
      <div className="sl-flow">
        {stages.map((label, i) => (
          <div
            key={label}
            className={i < stage ? "done" : i === stage ? "current" : ""}
          >
            <strong>
              {i < stage ? <Check size={13} strokeWidth={3} /> : null}
              {label}
            </strong>
            <small>
              {i === 0
                ? briefing
                  ? `salvo ${relativeDays(briefing.updated_at)}`
                  : "sem briefing"
                : i === 1
                  ? `${bundle.plan.source === "artifact" ? "importado do artefato" : bundle.plan.source === "ai" ? "gerado pela MAVI" : "editado"} · ${bundle.revisions.length} ${bundle.revisions.length === 1 ? "versão anterior" : "versões anteriores"}`
                  : i === 2
                    ? bundle.plan.share_enabled
                      ? `${approved + rejected} de ${total} · link enviado ${relativeDays(bundle.plan.shared_at)}`
                      : `${approved + rejected} de ${total} · link não enviado`
                    : i === 3
                      ? withTask
                        ? `${withArt} de ${total} com arte · ${withTask} ${withTask === 1 ? "tarefa" : "tarefas"}`
                        : allApproved
                          ? "pronta para liberar"
                          : "depois da aprovação"
                      : item.campaign
                        ? item.campaign.active
                          ? "no ar no Meta"
                          : "criada, ainda inativa"
                        : "depois das artes"}
            </small>
          </div>
        ))}
      </div>

      <div className="sl-plan-bar">
        <p>
          {bundle.plan.label} · criado em {date(bundle.plan.created_at)}
          {bundle.plan.summary ? ` · ${maviText(bundle.plan.summary)}` : ""}
          {cost.total > 0 && (
            <span
              className="sl-cost"
              title={[
                cost.generations
                  ? `${cost.generations} ${cost.generations === 1 ? "geração" : "gerações"}: ${formatUsd(cost.generateCost)}`
                  : "",
                cost.adjustments
                  ? `${cost.adjustments} ${cost.adjustments === 1 ? "ajuste" : "ajustes"}: ${formatUsd(cost.adjustCost)}`
                  : "",
                `${cost.tokens.toLocaleString("pt-BR")} tokens na API da Claude`,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <Sparkles size={12} /> MAVI {formatUsd(cost.total)}
            </span>
          )}
        </p>
        {item.can_write && (
          <div className="sl-plan-actions">
            {toRelease > 0 && (
              <Button
                className="btn primary"
                onClick={() => setModal("release")}
              >
                <Hammer size={16} /> Liberar produção ({toRelease})
              </Button>
            )}
            {allApproved && toRelease === 0 && isLeader && (
              <Button
                className={`btn ${withArt === total && !item.campaign?.active ? "primary" : "secondary"}`}
                onClick={() =>
                  item.campaign?.id
                    ? navigate(
                        appPath(`/campanhas?campanha=${item.campaign.id}`),
                      )
                    : setModal("campaign")
                }
              >
                <Megaphone size={16} />
                {item.campaign?.id ? "Abrir campanha" : "Criar campanha"}
              </Button>
            )}
            {!isLatest ? null : allApproved ? (
              <Button
                className={`btn ${toRelease === 0 && (item.campaign?.active || !isLeader) ? "primary" : "secondary"}`}
                onClick={() => {
                  setCount(null);
                  setModal("next-month");
                }}
                disabled={running}
              >
                <Sparkles size={16} /> Gerar Mês {bundle.plan.month_number + 1}
              </Button>
            ) : (
              // With posts to release, the release is the main action.
              <Button
                className={`btn ${toRelease > 0 ? "secondary" : "primary"}`}
                onClick={() => setModal("share")}
              >
                {bundle.plan.share_enabled ? (
                  <Link2 size={16} />
                ) : (
                  <Send size={16} />
                )}
                {bundle.plan.share_enabled
                  ? "Link de aprovação"
                  : "Enviar para aprovação"}
              </Button>
            )}
            {allApproved && (
              <Button
                className="btn secondary"
                onClick={() => setModal("share")}
              >
                <Link2 size={16} /> Link
              </Button>
            )}
            {isLatest && !allApproved && (
              <Button
                className="btn secondary"
                disabled={running}
                title="Criar o plano do próximo mês sem esperar a aprovação deste"
                onClick={() => {
                  setCount(null);
                  setModal("next-month");
                }}
              >
                <Sparkles size={15} /> Novo plano: Mês{" "}
                {bundle.plan.month_number + 1}
              </Button>
            )}
            <Button
              className="btn secondary"
              disabled={allApproved || running}
              title={
                allApproved
                  ? 'Plano aprovado. Para mudar um post, use "Alterar" nele ou "Pedir ajuste à MAVI".'
                  : `Escrever de novo os posts deste mês (hoje ${total})`
              }
              onClick={() => {
                setCount(null);
                setModal("regenerate");
              }}
            >
              {allApproved ? <Lock size={15} /> : <RefreshCw size={15} />}
              {allApproved ? "Plano aprovado" : "Regenerar este mês"}
            </Button>
            <Button
              className="btn secondary"
              onClick={() => setModal("import")}
              title="Colar a atualização devolvida pelo chat"
            >
              <FileJson size={15} /> Colar do chat
            </Button>
            <Button
              className="btn secondary"
              onClick={() => setModal("pdf")}
              title="PDF do designer e PDF de apresentação"
            >
              <FileText size={15} /> PDFs
            </Button>
          </div>
        )}
      </div>

      <div className="scope-tabs" role="tablist" aria-label="Partes do plano">
        {(
          [
            ["posts", "Posts", total],
            ["estrategia", "Estratégia", null],
            ["campanha", "Campanha", null],
            [
              "alertas",
              "Alertas",
              content.alertas.filter(
                (a) => !reads.some((r) => r.alert_text === a),
              ).length +
                flags.filter(
                  (f) => !reads.some((r) => r.alert_text === flagText(f)),
                ).length,
            ],
            ["versoes", "Versões", bundle.revisions.length],
          ] as const
        ).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={section === id ? "selected" : ""}
            onClick={() => setSection(id)}
          >
            {label}
            {n !== null && <span>{n}</span>}
          </button>
        ))}
      </div>

      {section === "posts" && (
        <>
          {item.can_write && (
            <AdjustBox
              disabled={running}
              onAsk={async (instruction) => {
                const r = await backend.adjust(
                  company,
                  item.contract_id,
                  plan.id,
                  instruction,
                );
                setPreview({
                  text: JSON.stringify(r.update),
                  reason: "ajuste pedido à IA",
                  source: "ai",
                });
                return r.cost_usd;
              }}
              notify={notify}
            />
          )}
          <div className="sl-posts">
            {posts.map((p) => {
              const f = flags.filter((x) => x.post === p.number);
              return (
                <button
                  key={p.number}
                  type="button"
                  className={`sl-post ${p.is_ad ? "ad" : ""} ${p.decision}`}
                  onClick={() => setOpenPost(p.number)}
                >
                  <span className="sl-post-top">
                    <span className="sl-num">
                      {String(p.number).padStart(2, "0")}
                    </span>
                    {p.is_ad ? (
                      <span className="sl-pill ad">
                        <Megaphone size={11} /> Vira anúncio
                      </span>
                    ) : (
                      <span className={`sl-pill ${p.pillar}`}>
                        {pillars[p.pillar]}
                      </span>
                    )}
                  </span>
                  <strong>{p.hook}</strong>
                  <small>
                    {p.format} · {p.cta}
                  </small>
                  <PostTextChips post={p} />
                  {!!f.length && (
                    <span className="sl-flag">
                      <TriangleAlert size={12} /> “{f[0].term}”: {f[0].why}
                    </span>
                  )}
                  {(p.task_id || !!p.arts?.length) && (
                    <span className="sl-post-prod">
                      {p.task_id && (
                        <span
                          className={`sl-task-chip ${taskOf(p)?.status ?? ""}`}
                        >
                          <Hammer size={11} />
                          {taskOf(p)
                            ? (statuses[taskOf(p)!.status as Status]?.label ??
                              "Tarefa")
                            : "Tarefa"}
                        </span>
                      )}
                      {!!p.arts?.length && (
                        <span className="sl-art-chip">
                          <ImageIcon size={11} /> {p.arts.length}{" "}
                          {p.arts.length === 1 ? "arte" : "artes"}
                        </span>
                      )}
                    </span>
                  )}
                  <span className="sl-post-foot">
                    <span className={`sl-decision ${p.decision}`}>
                      {decisionLabel[p.decision]}
                    </span>
                    {p.decided_via && (
                      <span>
                        {p.decided_via === "link"
                          ? "pelo cliente"
                          : `por ${people(p.decided_by)?.split(" ")[0] ?? "equipe"}`}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {section === "estrategia" && <Strategy content={content} />}
      {section === "campanha" && (
        <Campaign
          content={content}
          objective={briefing?.campaign_objective ?? null}
          notify={notify}
        />
      )}
      {section === "alertas" && (
        <Alerts
          content={content}
          flags={flags}
          reads={reads}
          who={people}
          onMark={async (text, kind, read) => {
            try {
              await backend.markAlert(plan.id, text, kind, read);
              load();
              onChanged();
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        />
      )}
      {section === "versoes" && (
        <Revisions
          bundle={bundle}
          canWrite={item.can_write}
          who={people}
          onRestore={async (id) => {
            await backend.restore(id, bundle.plan.version);
            notify("Versão restaurada. A anterior ficou guardada nas versões.");
            load();
            onChanged();
          }}
          notify={notify}
        />
      )}

      {openPost !== null && (
        <PostModal
          post={posts.find((p) => p.number === openPost)!}
          content={content}
          canWrite={item.can_write}
          company={company}
          demo={demo}
          notify={notify}
          who={people}
          flags={flags.filter((f) => f.post === openPost)}
          onClose={() => setOpenPost(null)}
          onDecide={async (d, note) => {
            await backend.decide(plan.id, openPost, d, note);
            notify(
              d === "pending"
                ? `Post ${openPost} reaberto.`
                : d === "approved"
                  ? `Post ${openPost} aprovado.`
                  : `Ajuste registrado no post ${openPost}.`,
            );
            load();
            onChanged();
          }}
          onEdit={async (patch) => {
            await write(
              editPost(content, openPost, patch),
              "edição manual",
              "manual",
              `Post ${openPost} editado`,
            );
            notify(`Post ${openPost} salvo. A versão anterior ficou guardada.`);
          }}
          production={{
            task: taskOf(posts.find((p) => p.number === openPost)!),
            assignee: people(
              taskOf(posts.find((p) => p.number === openPost)!)?.assignee_id ??
                null,
            ),
            onOpenTask: (id) => navigate(appPath(`/tarefas/${id}`)),
            urlOf: (f) => backend.mediaUrl(f),
            onUpload: async (file, onProgress) =>
              backend.uploadMedia(
                company,
                item.contract_id,
                file,
                onProgress,
                monthFolder(bundle.plan.label),
              ),
            onSave: async (arts) => {
              await backend.setArts(plan.id, openPost, arts);
              load();
              onChanged();
            },
            onDelete: (f) => backend.deleteMedia(f),
            notify,
          }}
          events={(bundle.events ?? []).filter((e) => e.number === openPost)}
          onComment={async (note) => {
            await backend.comment(plan.id, openPost, note);
            load();
          }}
        />
      )}
      {modal === "share" && (
        <ShareModal
          plan={bundle.plan}
          briefing={briefing}
          clientName={clientName}
          backend={backend}
          decided={approved + rejected}
          total={total}
          onClose={() => setModal(null)}
          onChanged={() => {
            load();
            onChanged();
          }}
          notify={notify}
        />
      )}
      {modal === "release" && (
        <ReleaseModal
          label={bundle.plan.label}
          posts={posts.filter((p) => p.decision === "approved" && !p.task_id)}
          waiting={total - withTask - toRelease}
          startsCycle={!briefing?.cycle}
          user={user}
          production={production}
          clientId={item.client_id}
          data={data}
          onClose={() => setModal(null)}
          onRelease={async (assign, cycle) => {
            const r = await backend.release(plan.id, assign, cycle);
            notify(
              `${r.created} ${r.created === 1 ? "tarefa de arte criada" : "tarefas de arte criadas"}${r.cycle ? " e ciclo do cliente iniciado" : ""}.`,
            );
            setModal(null);
            load();
            onChanged();
          }}
        />
      )}
      {modal === "campaign" && (
        <Modal
          title="Criar a campanha no Meta"
          onClose={() => setModal(null)}
          busy={busy === "campaign"}
        >
          <div className="entity-form">
            <p>
              A campanha{" "}
              <strong>
                {mod.name} · {clientName}
              </strong>{" "}
              é criada
              em Campanhas, ainda inativa, com o objetivo, a região, o público,
              o orçamento e o post que vira anúncio nas observações. Lá você
              completa o ciclo (verba, datas, conta de anúncio) e ativa. Quando
              ela estiver ativa, este cliente aparece como “Campanha no ar”.
            </p>
            {withArt < total && (
              <p className="sl-alert warn">
                <TriangleAlert size={15} />
                {withArt} de {total} posts com arte. Dá para criar agora e
                ativar quando o anúncio estiver pronto.
              </p>
            )}
            <div className="form-footer">
              <Button className="btn secondary" onClick={() => setModal(null)}>
                Cancelar
              </Button>
              <Button
                className="btn primary"
                loading={busy === "campaign"}
                onClick={() => {
                  setBusy("campaign");
                  backend
                    .createCampaign(plan.id)
                    .then((id) => {
                      notify(
                        "Campanha criada. Complete o ciclo e ative em Campanhas.",
                      );
                      onChanged();
                      navigate(appPath(`/campanhas?campanha=${id}`));
                    })
                    .catch((e) => notify((e as Error).message))
                    .finally(() => setBusy(""));
                }}
              >
                <Megaphone size={15} /> Criar e abrir em Campanhas
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {modal === "pdf" && (
        <PdfModal
          plan={bundle.plan}
          posts={posts}
          content={content}
          briefing={briefing}
          clientName={clientName}
          company={data.companies.find((c) => c.id === company)?.name ?? ""}
          responsible={people(briefing?.responsible_id ?? null) ?? null}
          backend={backend}
          onSaveCopy={(file) =>
            backend.uploadMedia(
              company,
              item.contract_id,
              file,
              () => {},
              monthFolder(bundle.plan.label),
            )
          }
          onClose={() => setModal(null)}
          notify={notify}
        />
      )}
      {modal === "regenerate" && (
        <Modal
          title={`Regenerar o ${bundle.plan.label}?`}
          onClose={() => setModal(null)}
          busy={!!busy}
        >
          <div className="entity-form">
            <p>
              A MAVI escreve de novo os posts com o briefing atual, cada um com
              o texto da imagem, do vídeo e a legenda. O plano de agora fica
              guardado em Versões.
            </p>
            <PostCountInput value={postCount} onChange={setCount} />
            {approved + rejected > 0 && (
              <p className="sl-alert warn">
                <TriangleAlert size={15} />
                {approved + rejected}{" "}
                {approved + rejected === 1
                  ? "avaliação será perdida"
                  : "avaliações serão perdidas"}
                : {approved} {approved === 1 ? "aprovada" : "aprovadas"} e{" "}
                {rejected}{" "}
                {rejected === 1 ? "com ajuste pedido" : "com ajuste pedido"}.
                Para mudar só alguns posts, use “Pedir ajuste à MAVI”.
              </p>
            )}
            <div className="form-footer">
              <Button className="btn secondary" onClick={() => setModal(null)}>
                Cancelar
              </Button>
              <Button
                className="btn primary"
                loading={busy === "current"}
                onClick={() => void generate("current", postCount)}
              >
                <RefreshCw size={15} /> Regenerar com {postCount} posts
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {modal === "next-month" && (
        <Modal
          title={`Gerar o Mês ${(plans.at(-1)?.month_number ?? 0) + 1}?`}
          onClose={() => setModal(null)}
          busy={!!busy}
        >
          <div className="entity-form">
            <p>
              A MAVI usa o briefing atual e o que o cliente aprovou e pediu para
              ajustar no {plans.at(-1)?.label}, sem repetir ganchos. Cada post
              vem com o texto exato da imagem, do vídeo e a legenda.
            </p>
            {!allApproved && (
              <p className="sl-alert warn">
                <TriangleAlert size={15} />O {plans.at(-1)?.label} ainda tem{" "}
                {total - approved}{" "}
                {total - approved === 1
                  ? "post sem aprovação"
                  : "posts sem aprovação"}
                . O novo plano não muda nada nele.
              </p>
            )}
            <PostCountInput value={postCount} onChange={setCount} />
            <div className="form-footer">
              <Button className="btn secondary" onClick={() => setModal(null)}>
                Cancelar
              </Button>
              <Button
                className="btn primary"
                loading={busy === "new"}
                onClick={() => void generate("new", postCount)}
              >
                <Sparkles size={15} /> Gerar {postCount} posts
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {modal === "import" && (
        <ImportModal
          onClose={() => setModal(null)}
          onValidate={(text) => {
            setModal(null);
            setPreview({
              text,
              reason: "importação da conversa no chat",
              source: "import",
            });
          }}
        />
      )}
      {preview && (
        <PreviewModal
          text={preview.text}
          content={content}
          opened={{
            clientSlugs: [slugify(item.client_name), slugify(clientName)],
            planId: plan.id,
            planLabel: bundle.plan.label,
          }}
          onClose={() => setPreview(null)}
          onApply={async (next, summary) => {
            await write(next, preview.reason, preview.source, summary);
            setPreview(null);
            notify("Plano atualizado. A versão anterior ficou guardada.");
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ post
/** The exact texts of a post: field, label and what each one is for. */
const POST_TEXTS = [
  {
    key: "textoImagem",
    column: "image_text",
    label: "Texto da(s) imagem(ns)",
    hint: "O que vai escrito na arte, slide a slide. A sugestão de imagem é só uma ideia para o designer.",
  },
  {
    key: "textoVideo",
    column: "video_text",
    label: "Texto do vídeo",
    hint: "Roteiro: falas e textos na tela, cena por cena.",
  },
  {
    key: "legenda",
    column: "caption",
    label: "Legenda (copy)",
    hint: "A legenda completa, como vai ser publicada.",
  },
] as const;

/** Which exact texts a post has, on its card. */
function PostTextChips({ post }: { post: SlPost }) {
  const has = POST_TEXTS.filter((t) => postTextPlain(post[t.column]));
  if (!has.length) return null;
  return (
    <span className="sl-text-chips" aria-label="Textos prontos">
      {has.map((t) => (
        <span key={t.key}>
          {t.key === "textoImagem"
            ? "Imagem"
            : t.key === "textoVideo"
              ? "Vídeo"
              : "Legenda"}
        </span>
      ))}
    </span>
  );
}

function PostModal({
  post,
  content,
  canWrite,
  company,
  demo,
  notify,
  who,
  flags,
  onClose,
  onDecide,
  onEdit,
  production,
  events,
  onComment,
}: {
  post: SlPost;
  content: PlanContent;
  canWrite: boolean;
  company: string;
  demo: boolean;
  notify: (m: string) => void;
  who: (id: string | null) => string | undefined;
  flags: ReturnType<typeof complianceFlags>;
  onClose: () => void;
  onDecide: (d: Decision, note: string) => Promise<void>;
  onEdit: (patch: Partial<PlanPost>) => Promise<void>;
  production: ProductionProps;
  /** This post's history, oldest first. */
  events: SlPostEvent[];
  onComment: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState(post.note);
  const [editing, setEditing] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = content.posts.find((p) => p.numero === post.number)!;
  const [draft, setDraft] = useState<PlanPost>(current);
  const lastClick = useRef({ what: "", at: 0 });
  const run = async (what: string, fn: () => Promise<void>) => {
    // A second click on the same button right after is ignored (B29).
    const now = Date.now();
    if (lastClick.current.what === what && now - lastClick.current.at < 800)
      return;
    lastClick.current = { what, at: now };
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decided = post.decision !== "pending" && !reopen;

  return (
    <Modal
      title={`Post ${post.number}${post.is_ad ? " · vira anúncio" : ""}`}
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="sl-post-modal">
        {editing ? (
          <form
            className="entity-form"
            onSubmit={(e) => {
              e.preventDefault();
              // The editors keep their text in hidden inputs (serialized).
              const form = new FormData(e.currentTarget);
              // The editor rewrites plain text as rich text when it opens:
              // an untouched text stays as it was (no false edit).
              const texts = Object.fromEntries(
                POST_TEXTS.map((t) => {
                  const next = String(form.get(t.key) ?? "");
                  const was = draft[t.key] ?? "";
                  const same =
                    next === was ||
                    next === serializeDescription(parseDescription(was));
                  return [t.key, same ? was : next];
                }),
              );
              void run("edit", async () => {
                await onEdit({ ...draft, ...texts });
                setEditing(false);
              });
            }}
          >
            {post.decision !== "pending" && (
              <p className="sl-alert warn">
                <TriangleAlert size={15} /> Este post já foi avaliado. Mudar o
                conteúdo volta ele para pendente.
              </p>
            )}
            <div className="form-columns">
              <label>
                Pilar
                <Select
                  value={draft.badge}
                  onValueChange={(v) =>
                    setDraft({ ...draft, badge: v as Pillar })
                  }
                >
                  {(Object.keys(pillars) as Pillar[]).map((p) => (
                    <SelectOption key={p} value={p}>
                      {pillars[p]}
                    </SelectOption>
                  ))}
                </Select>
              </label>
              <label>
                Formato
                <Input
                  value={draft.formato}
                  required
                  onChange={(e) =>
                    setDraft({ ...draft, formato: e.target.value })
                  }
                />
              </label>
            </div>
            <label>
              Gancho
              <Input
                value={draft.gancho}
                required
                maxLength={500}
                onChange={(e) => setDraft({ ...draft, gancho: e.target.value })}
              />
            </label>
            <label>
              Direção de copy
              <Textarea
                rows={3}
                value={draft.direcaoCopy}
                required
                onChange={(e) =>
                  setDraft({ ...draft, direcaoCopy: e.target.value })
                }
              />
            </label>
            <label>
              Direção visual
              <Textarea
                rows={3}
                value={draft.direcaoVisual}
                required
                onChange={(e) =>
                  setDraft({ ...draft, direcaoVisual: e.target.value })
                }
              />
            </label>
            <label>
              CTA
              <Input
                value={draft.cta}
                required
                onChange={(e) => setDraft({ ...draft, cta: e.target.value })}
              />
            </label>
            <div className="sl-post-texts-edit">
              <p className="sl-muted">
                Os textos exatos da peça. Formate à vontade: negrito, cores e
                listas chegam assim à tarefa de arte e ao link do cliente.
              </p>
              <Suspense fallback={<Loading compact />}>
                {POST_TEXTS.map((t) => (
                  <div key={t.key} className="sl-post-text-field">
                    <RichTextEditor
                      name={t.key}
                      label={t.label}
                      defaultValue={draft[t.key] ?? ""}
                      company={company}
                      demo={demo}
                      images={false}
                    />
                    <em>{t.hint}</em>
                  </div>
                ))}
              </Suspense>
            </div>
            <label className="checkbox-label">
              <Checkbox
                checked={draft.ehAnuncio}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, ehAnuncio: v === true })
                }
              />
              Este post vira o anúncio do mês (tira o anúncio do post atual)
            </label>
            {error && <p className="sl-alert bad">{error}</p>}
            <div className="form-footer">
              <Button
                type="button"
                className="btn secondary"
                onClick={() => setEditing(false)}
              >
                Cancelar
              </Button>
              <Button type="submit" className="btn primary" loading={busy}>
                Salvar post
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="sl-post-detail">
              <div className="sl-post-top">
                <span className={`sl-pill ${post.pillar}`}>
                  {pillars[post.pillar]}
                </span>
                {post.is_ad && (
                  <span className="sl-pill ad">
                    <Megaphone size={11} /> Vira anúncio
                  </span>
                )}
              </div>
              <h3>{post.hook}</h3>
              <dl>
                <dt>Direção de copy</dt>
                <dd>{post.copy_direction}</dd>
                <dt>Direção visual</dt>
                <dd>{post.visual_direction}</dd>
                <dt>Formato</dt>
                <dd>{post.format}</dd>
                <dt>CTA</dt>
                <dd>{post.cta}</dd>
              </dl>
              <PostTexts post={post} notify={notify} />
              {flags.map((f) => (
                <p key={f.field + f.term} className="sl-alert warn">
                  <TriangleAlert size={15} />
                  {f.field}: “{f.term}”, {f.why}.
                </p>
              ))}
              {canWrite && (
                <Button
                  className="btn secondary"
                  onClick={() => setEditing(true)}
                >
                  <Pencil size={15} /> Editar post
                </Button>
              )}
            </div>
            <div className="sl-decide">
              <h4>Decisão do cliente</h4>
              {decided ? (
                <>
                  <p className={`sl-decided ${post.decision}`}>
                    {post.decision === "approved" ? (
                      <Check size={16} />
                    ) : (
                      <X size={16} />
                    )}
                    {post.decision === "approved"
                      ? "Aprovado"
                      : "Ajuste pedido"}{" "}
                    {post.decided_via === "link"
                      ? "pelo cliente, no link"
                      : `(registrado por ${who(post.decided_by) ?? "equipe"})`}
                    <small>{dateTime(post.decided_at)}</small>
                  </p>
                  {post.note && <blockquote>{post.note}</blockquote>}
                  {canWrite && (
                    <button
                      type="button"
                      className="sl-link"
                      onClick={() => setReopen(true)}
                    >
                      Alterar
                    </button>
                  )}
                </>
              ) : canWrite ? (
                <>
                  <p className="sl-muted">
                    Quando o cliente decide pelo link, aparece aqui sozinho. Use
                    estes botões para registrar o que ele disse em reunião ou no
                    WhatsApp.
                  </p>
                  <Textarea
                    rows={3}
                    placeholder="Observação do cliente (obrigatória para pedir ajuste)"
                    value={note}
                    maxLength={2000}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  {error && <p className="sl-alert bad">{error}</p>}
                  <div className="sl-decide-buttons">
                    <Button
                      className="btn secondary"
                      disabled={busy || !note.trim()}
                      title={
                        note.trim()
                          ? ""
                          : "Escreva o que o cliente quer ajustar"
                      }
                      onClick={() =>
                        void run("rejected", () =>
                          onDecide("rejected", note).then(() =>
                            setReopen(false),
                          ),
                        )
                      }
                    >
                      <X size={15} /> Pedir ajuste
                    </Button>
                    <Button
                      className="btn primary"
                      disabled={busy}
                      onClick={() =>
                        void run("approved", () =>
                          onDecide("approved", note).then(() =>
                            setReopen(false),
                          ),
                        )
                      }
                    >
                      <Check size={15} /> Aprovar
                    </Button>
                  </div>
                  {reopen && (
                    <button
                      type="button"
                      className="sl-link"
                      onClick={() =>
                        void run("pending", () =>
                          onDecide("pending", "").then(() => setReopen(false)),
                        )
                      }
                    >
                      Voltar para pendente
                    </button>
                  )}
                </>
              ) : (
                <p className="sl-muted">Pendente.</p>
              )}
              {(post.decision === "approved" ||
                post.task_id ||
                !!post.arts?.length) && (
                <PostProduction
                  post={post}
                  canWrite={canWrite}
                  {...production}
                />
              )}
            </div>
            <PostHistory events={events} onComment={onComment} />
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Everything that happened to the post, as a timeline: approvals and
 * adjustments (by the team or the client on the link) with their notes,
 * edits with what changed, arts, the art task and the team's comments.
 */
function PostHistory({
  events,
  onComment,
}: {
  events: SlPostEvent[];
  onComment: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLOListElement>(null);
  // The newest is at the bottom, next to the comment box.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  const send = () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    setError("");
    onComment(note)
      .then(() => setNote(""))
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <section className="sl-history" aria-label="Histórico do post">
      <h4>
        <History size={15} /> Histórico
        <small>
          {events.length}{" "}
          {events.length === 1 ? "acontecimento" : "acontecimentos"}
        </small>
      </h4>
      {events.length ? (
        <ol className="sl-history-list" ref={list}>
          {events.map((e) => {
            const d = describeEvent(e);
            return (
              <li key={e.id} className={`sl-history-item ${d.tone} ${e.kind}`}>
                <span className="sl-history-dot" aria-hidden="true">
                  {e.kind === "approved" ? (
                    <Check size={12} />
                  ) : e.kind === "rejected" ? (
                    <X size={12} />
                  ) : e.kind === "comment" ? (
                    <MessageSquare size={11} />
                  ) : e.kind === "edited" ? (
                    e.via === "ai" ? (
                      <Sparkles size={11} />
                    ) : (
                      <Pencil size={11} />
                    )
                  ) : e.kind === "arts" ? (
                    <ImageIcon size={11} />
                  ) : e.kind === "task" ? (
                    <Hammer size={11} />
                  ) : e.kind === "reopened" ? (
                    <RotateCcw size={11} />
                  ) : null}
                </span>
                <div className="sl-history-body">
                  <p className="sl-history-title">
                    <strong>{d.title}</strong>
                    <time dateTime={e.created_at}>
                      {dateTime(e.created_at)}
                    </time>
                  </p>
                  {e.note && <blockquote>{e.note}</blockquote>}
                  {!!d.changes.length && (
                    <dl className="sl-history-changes">
                      {d.changes.map((c) => (
                        <div key={c.label}>
                          <dt>{c.label}</dt>
                          <dd>
                            <del>{c.before || "—"}</del>
                            <ins>{c.after || "—"}</ins>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {d.lines.map((l) => (
                    <p key={l} className="sl-history-line">
                      {l}
                    </p>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="sl-muted">Nada registrado ainda.</p>
      )}
      <form
        className="sl-history-compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Textarea
          rows={2}
          value={note}
          maxLength={2000}
          aria-label="Comentar no histórico do post"
          placeholder="Comente: o que o cliente disse, uma decisão, um lembrete para a criação…"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button
          type="submit"
          className="btn secondary"
          loading={busy}
          disabled={!note.trim()}
        >
          <Send size={14} /> Comentar
        </Button>
      </form>
      {error && <p className="sl-alert bad">{error}</p>}
    </section>
  );
}

type ProductionProps = {
  task: SlTask | undefined;
  assignee: string | undefined;
  onOpenTask: (id: string) => void;
  urlOf: (f: MediaFile) => Promise<string>;
  onUpload: (file: File, onProgress: (f: number) => void) => Promise<MediaFile>;
  onSave: (arts: MediaFile[]) => Promise<void>;
  onDelete: (f: MediaFile) => Promise<void>;
  notify: (m: string) => void;
};
/** The post's art task and its arts (sent to the client's Drive). */
function PostProduction({
  post,
  canWrite,
  task,
  assignee,
  onOpenTask,
  urlOf,
  onUpload,
  onSave,
  onDelete,
  notify,
}: ProductionProps & { post: SlPost; canWrite: boolean }) {
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const arts = useRef<MediaFile[]>(post.arts ?? []);
  arts.current = post.arts ?? arts.current;
  const add = async (files: File[]) => {
    for (const file of files) {
      const kind = file.type.split("/")[0];
      if (
        !["image", "video"].includes(kind) &&
        file.type !== "application/pdf"
      ) {
        notify(`${file.name}: envie imagem, vídeo ou PDF.`);
        continue;
      }
      if (file.size > 500 * 1024 * 1024) {
        notify(`${file.name}: envie arquivos de até 500 MB.`);
        continue;
      }
      const key = `${Date.now()}-${file.name}`;
      setUploading((u) => [...u, { key, name: file.name, progress: 0 }]);
      try {
        const sent = await onUpload(file, (progress) =>
          setUploading((u) =>
            u.map((x) => (x.key === key ? { ...x, progress } : x)),
          ),
        );
        arts.current = [...arts.current, sent];
        await onSave(arts.current);
      } catch (e) {
        notify((e as Error).message);
      } finally {
        setUploading((u) => u.filter((x) => x.key !== key));
      }
    }
  };
  return (
    <div className="sl-production">
      <h4>Produção</h4>
      {task ? (
        <p className="sl-task-line">
          <span className={`sl-task-chip ${task.status}`}>
            <Hammer size={11} />{" "}
            {statuses[task.status as Status]?.label ?? task.status}
          </span>
          <span>
            {assignee ?? "Equipe de criação"} · até{" "}
            {new Date(`${task.due_date}T12:00:00`).toLocaleDateString("pt-BR")}
          </span>
          <button
            type="button"
            className="sl-link"
            onClick={() => onOpenTask(task.id)}
          >
            Abrir tarefa
          </button>
        </p>
      ) : post.task_id ? (
        <p className="sl-muted">Tarefa de arte criada (sem acesso para ver).</p>
      ) : (
        <p className="sl-muted">
          Sem tarefa de arte ainda: use “Liberar produção”.
        </p>
      )}
      <MediaInput
        files={post.arts ?? []}
        uploading={uploading}
        accept="image/*,video/*,application/pdf"
        what="as artes"
        disabled={!canWrite}
        onAdd={(files) => void add(files)}
        onRemove={(f) => {
          arts.current = arts.current.filter((a) => a.id !== f.id);
          onSave(arts.current)
            .then(() =>
              onDelete(f).catch(() =>
                notify(
                  `${f.name} saiu do post, mas continua no Drive do cliente.`,
                ),
              ),
            )
            .catch((e) => notify((e as Error).message));
        }}
        urlOf={urlOf}
      />
    </div>
  );
}

// ------------------------------------------------------------ share
function ShareModal({
  plan,
  briefing,
  clientName,
  backend,
  decided,
  total,
  onClose,
  onChanged,
  notify,
}: {
  plan: SlPlan;
  briefing: SlBriefing | null;
  clientName: string;
  backend: SocialLeadsBackend;
  decided: number;
  total: number;
  onClose: () => void;
  onChanged: () => void;
  notify: (m: string) => void;
}) {
  const [state, setState] = useState<{
    share_enabled: boolean;
    share_token: string;
  } | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = (enabled: boolean, newLink = false) => {
    setBusy(true);
    setError("");
    backend
      .share(plan.id, enabled, newLink)
      .then((s) => {
        setState(s);
        onChanged();
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  // Opening the window turns the link on (that's what it is for).
  useEffect(() => act(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  const url = state ? shareUrl(state.share_token) : "";
  const contact = briefing?.fields.contactName?.split(" ")[0];
  const message = `Olá${contact ? `, ${contact}` : ""}! O plano de conteúdo do ${plan.label} da ${clientName} está pronto. Dá para ver e aprovar cada post por aqui: ${url}`;
  const phone = (briefing?.fields.contactWhats ?? "").replace(/\D/g, "");
  const wa = phone
    ? `https://wa.me/${phone.length <= 11 ? `55${phone}` : phone}?text=${encodeURIComponent(message)}`
    : "";
  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => notify(`${what} copiado.`),
      () => notify("Não foi possível copiar. Selecione o texto e copie."),
    );
  };
  if (preview && state && backend.link)
    return (
      <Modal title="Como o cliente vê" onClose={() => setPreview(false)} wide>
        <PublicSocialLeads
          token={state.share_token}
          source={backend.link}
          embedded
        />
      </Modal>
    );
  return (
    <Modal title="Link de aprovação do cliente" onClose={onClose} busy={busy}>
      <div className="entity-form sl-share">
        {!state ? (
          error ? (
            <p className="sl-alert bad">{error}</p>
          ) : (
            <Loading compact />
          )
        ) : state.share_enabled ? (
          <>
            <p>
              O cliente abre o plano no celular, sem senha, e aprova ou pede
              ajuste em cada post. A decisão aparece aqui na hora.{" "}
              {decided > 0 && `${decided} de ${total} já decididos.`}
            </p>
            <label>
              Endereço
              <span className="sl-copy-row">
                <Input
                  readOnly
                  value={url}
                  onFocus={(e) => e.target.select()}
                  icon={Link2}
                />
                <Button
                  className="btn secondary"
                  onClick={() => copy(url, "Link")}
                >
                  <Copy size={15} /> Copiar
                </Button>
              </span>
            </label>
            <label>
              Mensagem para o WhatsApp
              <Textarea
                readOnly
                rows={4}
                value={message}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <div className="sl-share-actions">
              <Button
                className="btn secondary"
                onClick={() => copy(message, "Mensagem")}
              >
                <Copy size={15} /> Copiar mensagem
              </Button>
              {wa && (
                <a
                  className="btn primary"
                  href={wa}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={15} /> Abrir no WhatsApp
                </a>
              )}
              {backend.link ? (
                <Button
                  className="btn secondary"
                  onClick={() => setPreview(true)}
                >
                  Ver como o cliente
                </Button>
              ) : (
                <a
                  className="btn secondary"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Ver como o cliente
                </a>
              )}
            </div>
            {error && <p className="sl-alert bad">{error}</p>}
            <div className="form-footer sl-share-foot">
              <button
                type="button"
                className="sl-link"
                disabled={busy}
                onClick={() => act(true, true)}
              >
                Trocar o link (o anterior para de funcionar)
              </button>
              <button
                type="button"
                className="sl-link danger"
                disabled={busy}
                onClick={() => act(false)}
              >
                Desligar o link
              </button>
            </div>
          </>
        ) : (
          <>
            <p>O link está desligado: quem tem o endereço não vê o plano.</p>
            <div className="form-footer">
              <Button
                className="btn primary"
                loading={busy}
                onClick={() => act(true)}
              >
                Ligar o link
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ AI and chat
const ASK_EXAMPLES = [
  "Deixe a linguagem dos posts mais leve",
  "Troque o CTA do anúncio para chamar no WhatsApp",
  "Mais posts de autoridade, menos de oferta",
  "Reescreva o gancho do post 1",
];
/**
 * "Pedir ajuste à IA": the most direct way to change the plan, so it sits
 * above the posts. The AI returns only what changes; the preview shows the
 * before and after, and applying keeps the previous version.
 */
function AdjustBox({
  disabled,
  onAsk,
  notify,
}: {
  disabled: boolean;
  /** Resolves with what the request cost. */
  onAsk: (instruction: string) => Promise<number>;
  notify: (m: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastCost, setLastCost] = useState<number | null>(null);
  const send = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    onAsk(text.trim())
      .then((cost) => {
        setText("");
        setLastCost(cost);
      })
      .catch((err) => notify((err as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="sl-ask-card"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="sl-ask-head">
        <span className="sl-ask-icon">
          <Sparkles size={18} />
        </span>
        <div>
          <strong>Pedir ajuste à MAVI</strong>
          <small>
            Diga o que mudar. Você vê o antes e depois antes de aplicar, e a
            versão atual fica guardada.
          </small>
        </div>
      </div>
      <div className="sl-ask-body">
        <Textarea
          rows={2}
          value={text}
          maxLength={2000}
          disabled={disabled || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder='Ex.: "deixe o post 6 mais leve e troque o CTA por WhatsApp"'
          aria-label="Pedir ajuste à MAVI"
        />
        <Button
          type="submit"
          className="btn primary"
          loading={busy}
          disabled={disabled || !text.trim()}
        >
          <Sparkles size={15} /> Ver mudanças
        </Button>
      </div>
      <div className="sl-ask-examples">
        {ASK_EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={disabled || busy}
            onClick={() => setText(ex)}
          >
            {ex}
          </button>
        ))}
        {lastCost !== null && lastCost > 0 && (
          <small className="sl-ask-cost">
            Último ajuste: {formatUsd(lastCost)}
          </small>
        )}
      </div>
      {busy && (
        <p className="sl-ai-note" role="status">
          <Sparkles size={14} /> A MAVI está preparando as mudanças…
        </p>
      )}
    </form>
  );
}

/**
 * "Liberar produção": who receives each post's art task. One choice for all
 * the posts at once, and each post can then be changed: a team (the task goes
 * to whoever has the fewest open tasks) or a person. The creative team comes
 * chosen. A team that doesn't serve the client yet starts serving it; a
 * person outside the client's teams gets the task but can't send the arts to
 * the post.
 */
function ReleaseModal({
  label,
  posts,
  waiting,
  startsCycle,
  user,
  production,
  clientId,
  data,
  onClose,
  onRelease,
}: {
  label: string;
  posts: SlPost[];
  /** Posts not approved yet (they stay for a next release). */
  waiting: number;
  /** This release opens the client's cycle (first one for the client). */
  startsCycle: boolean;
  /** Who is releasing: the recommended owner of the cycle tasks. */
  user: string;
  production: Production;
  clientId: string;
  data: Snapshot;
  onClose: () => void;
  onRelease: (assign: ReleaseAssign, cycle?: ReleaseCycle) => Promise<void>;
}) {
  const initial = production.teamId ? `team:${production.teamId}` : "";
  const [all, setAll] = useState(initial);
  const [each, setEach] = useState<Record<number, string>>(() =>
    Object.fromEntries(posts.map((p) => [p.number, initial])),
  );
  const [cycle, setCycle] = useState<ReleaseCycle>({
    followup: user,
    meeting: user,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const clientTeams = new Set(
    data.clientTeams
      .filter((c) => c.client_id === clientId)
      .map((c) => c.team_id),
  );
  const serves = (user: string) =>
    data.members.find((m) => m.user_id === user)?.role === "admin" ||
    data.teamMembers.some(
      (t) => t.user_id === user && clientTeams.has(t.team_id),
    );
  const teams = [...data.teams].sort((a, b) => a.name.localeCompare(b.name));
  const people = data.members
    .filter((m) => m.active)
    .sort((a, b) => a.name.localeCompare(b.name));
  const options = [
    ...teams.map((t) => ({
      value: `team:${t.id}`,
      label: `Equipe · ${t.name}${t.id === production.teamId ? " (criação)" : ""}${clientTeams.has(t.id) ? "" : " · passa a atender o cliente"}`,
    })),
    ...people.map((m) => ({
      value: `user:${m.user_id}`,
      label: `${m.name}${serves(m.user_id) ? "" : " · fora das equipes do cliente"}`,
    })),
  ];
  const outside = Object.values(each).some(
    (v) => v.startsWith("user:") && !serves(v.slice(5)),
  );
  // The cycle's owner is a person; the one releasing comes first.
  const owners = [
    ...people.filter((m) => m.user_id === user),
    ...people.filter((m) => m.user_id !== user),
  ];
  const missing = posts.filter((p) => !each[p.number]).map((p) => p.number);
  const perPost = new Set(Object.values(each)).size > 1;

  return (
    <Modal
      title={`Liberar a produção do ${label}`}
      onClose={onClose}
      busy={busy}
      wide
    >
      <form
        className="entity-form sl-release"
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.length) return;
          const assign: ReleaseAssign = {};
          for (const p of posts) {
            const [kind, id] = each[p.number].split(":");
            assign[p.number] = kind === "user" ? { user: id } : { team: id };
          }
          setBusy(true);
          setError("");
          onRelease(assign, startsCycle ? cycle : undefined)
            .catch((err) => setError((err as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <p>
          {posts.length}{" "}
          {posts.length === 1 ? "post aprovado vira" : "posts aprovados viram"}{" "}
          tarefa de arte, com prazo de {production.artDays}{" "}
          {production.artDays === 1 ? "dia" : "dias"}. Cada tarefa leva o
          gancho, a copy, a direção visual, o formato e o CTA do post. Para uma
          equipe, a tarefa vai para quem tem menos tarefas em aberto.
        </p>
        {startsCycle && (
          <section className="sl-release-cycle" aria-label="Ciclo do cliente">
            <header>
              <CalendarClock size={18} />
              <span>
                <strong>O ciclo do cliente começa nesta liberação</strong>
                <small>
                  Duas tarefas que se repetem até alguém parar. Escolha quem
                  cuida de cada uma.
                </small>
              </span>
            </header>
            {(
              [
                ["followup", "Acompanhamento quinzenal", "A cada 14 dias"],
                [
                  "meeting",
                  "Reunião de resultados e novo plano",
                  "Todo mês, com o plano do mês seguinte",
                ],
              ] as const
            ).map(([key, title, when]) => (
              <label key={key}>
                <span className="sl-label">
                  {title}
                  <em>{when}</em>
                </span>
                <Select
                  value={cycle[key]}
                  aria-label={`Responsável: ${title}`}
                  onValueChange={(v) =>
                    v && setCycle((c) => ({ ...c, [key]: v }))
                  }
                >
                  {owners.map((m) => (
                    <SelectOption key={m.user_id} value={m.user_id}>
                      {m.user_id === user
                        ? `${m.name} (você · recomendado)`
                        : m.name}
                    </SelectOption>
                  ))}
                </Select>
              </label>
            ))}
          </section>
        )}
        <label className="sl-release-all">
          <span className="sl-label">
            Para todos os posts
            <em>Muda todos de uma vez. Depois dá para trocar post a post.</em>
          </span>
          <Select
            value={perPost ? "" : all}
            onValueChange={(v) => {
              if (!v) return;
              setAll(v);
              setEach(Object.fromEntries(posts.map((p) => [p.number, v])));
            }}
          >
            <SelectOption value="">
              {perPost ? "Cada post com o seu" : "Escolha uma equipe ou pessoa"}
            </SelectOption>
            {options.map((o) => (
              <SelectOption key={o.value} value={o.value}>
                {o.label}
              </SelectOption>
            ))}
          </Select>
        </label>
        <ul className="sl-release-list">
          {posts.map((p) => (
            <li key={p.number}>
              <span className="sl-release-post">
                <span className="sl-num">
                  {String(p.number).padStart(2, "0")}
                </span>
                <span>
                  <strong>{p.hook}</strong>
                  <small>
                    {pillars[p.pillar]}
                    {p.is_ad ? " · vira anúncio (prioridade alta)" : ""} ·{" "}
                    {p.format}
                  </small>
                </span>
              </span>
              <Select
                value={each[p.number] ?? ""}
                aria-label={`Quem recebe o post ${p.number}`}
                onValueChange={(v) => setEach((e) => ({ ...e, [p.number]: v }))}
              >
                <SelectOption value="">
                  Escolha uma equipe ou pessoa
                </SelectOption>
                {options.map((o) => (
                  <SelectOption key={o.value} value={o.value}>
                    {o.label}
                  </SelectOption>
                ))}
              </Select>
            </li>
          ))}
        </ul>
        {outside && (
          <p className="sl-alert warn">
            <TriangleAlert size={15} />
            Quem está fora das equipes do cliente recebe a tarefa, mas não
            consegue subir as artes no post. Escolha a equipe dele ou adicione a
            equipe ao cliente.
          </p>
        )}
        {waiting > 0 && (
          <p className="sl-muted">
            {waiting}{" "}
            {waiting === 1
              ? "post ainda não aprovado fica"
              : "posts ainda não aprovados ficam"}{" "}
            para depois: libere de novo quando o cliente aprovar.
          </p>
        )}
        {error && <p className="sl-alert bad">{error}</p>}
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            className="btn primary"
            loading={busy}
            disabled={!!missing.length}
            title={
              missing.length
                ? `Escolha quem recebe o post ${missing.join(", ")}`
                : ""
            }
          >
            <Hammer size={15} /> Liberar {posts.length}{" "}
            {posts.length === 1 ? "tarefa" : "tarefas"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The designer's PDF and the presentation PDF, downloaded and kept in the Drive. */
function PdfModal({
  plan,
  posts,
  content,
  briefing,
  clientName,
  company,
  responsible,
  backend,
  onSaveCopy,
  onClose,
  notify,
}: {
  plan: SlPlan;
  posts: SlPost[];
  content: PlanContent;
  briefing: SlBriefing | null;
  clientName: string;
  company: string;
  responsible: string | null;
  backend: SocialLeadsBackend;
  onSaveCopy: (file: File) => Promise<MediaFile>;
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const [busy, setBusy] = useState<"" | "designer" | "presentation">("");
  const approvedPosts = posts.filter((p) => p.decision === "approved");
  const images = async (list: MediaFile[], max: number) => {
    const { loadImage } = await import("./social-leads-pdf");
    const out = [];
    for (const f of list
      .filter((a) => /^(image|video)\//.test(a.type))
      .slice(0, max)) {
      const img = await loadImage(
        await backend.mediaUrl(f).catch(() => ""),
        f.type,
      );
      if (img) out.push(img);
    }
    return out;
  };
  const make = async (kind: "designer" | "presentation") => {
    setBusy(kind);
    try {
      const pdf = await import("./social-leads-pdf");
      let blob: Blob;
      if (kind === "designer") {
        const [logo] = await images(briefing?.media?.brandLogo ?? [], 1);
        blob = await pdf.designerPdf({
          company,
          client: clientName,
          label: plan.label,
          fields: briefing?.fields ?? {},
          logo: logo ?? null,
          posts: approvedPosts,
        });
      } else {
        const arts: Record<number, Awaited<ReturnType<typeof images>>> = {};
        for (const p of posts)
          if (p.arts?.length) arts[p.number] = await images(p.arts, 4);
        const link = plan.share_enabled
          ? shareUrl((await backend.share(plan.id, true)).share_token)
          : null;
        blob = await pdf.presentationPdf({
          company,
          client: clientName,
          label: plan.label,
          createdAt: plan.created_at,
          responsible,
          content,
          posts,
          arts,
          link,
        });
      }
      const name = `${kind === "designer" ? "Designer" : "Apresentação"} · ${clientName} · ${plan.label}.pdf`;
      pdf.downloadBlob(blob, name);
      await onSaveCopy(new File([blob], name, { type: "application/pdf" }))
        .then(() => notify("PDF baixado. Uma cópia ficou no Drive do cliente."))
        .catch(() =>
          notify("PDF baixado. Não foi possível guardar a cópia no Drive."),
        );
    } catch (e) {
      notify((e as Error).message || "Não foi possível gerar o PDF.");
    } finally {
      setBusy("");
    }
  };
  return (
    <Modal title="PDFs do plano" onClose={onClose} busy={!!busy}>
      <div className="entity-form sl-pdfs">
        <button
          type="button"
          className="sl-pdf-card"
          disabled={!!busy || !approvedPosts.length}
          onClick={() => void make("designer")}
        >
          <FileText size={20} />
          <span>
            <strong>
              {busy === "designer" ? "Gerando…" : "PDF do designer"}
            </strong>
            <small>
              {approvedPosts.length
                ? `Os ${approvedPosts.length} posts aprovados, com identidade visual, restrições e as direções de cada peça.`
                : "Aparece quando houver posts aprovados."}
            </small>
          </span>
        </button>
        <button
          type="button"
          className="sl-pdf-card"
          disabled={!!busy}
          onClick={() => void make("presentation")}
        >
          <Presentation size={20} />
          <span>
            <strong>
              {busy === "presentation" ? "Gerando…" : "PDF de apresentação"}
            </strong>
            <small>
              Slides na identidade da Make: diagnóstico, pilares, os{" "}
              {posts.length} posts com as artes, os textos e o anúncio. Sem
              alertas nem dados internos.
            </small>
          </span>
        </button>
        <p className="sl-muted">
          O PDF é baixado e uma cópia fica no Drive do cliente, em “
          {monthFolder(plan.label)}”.
        </p>
      </div>
    </Modal>
  );
}

function ImportModal({
  onClose,
  onValidate,
}: {
  onClose: () => void;
  onValidate: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <Modal title="Colar a atualização do chat" onClose={onClose}>
      <form
        className="entity-form"
        onSubmit={(e) => {
          e.preventDefault();
          onValidate(text);
        }}
      >
        <p>
          Cole o JSON <code>social-leads-atualizacao</code> que a skill Social
          Leads devolveu no chat. Só muda o que vier nele.
        </p>
        <Textarea
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{"tipo": "social-leads-atualizacao", …}'
        />
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" disabled={!text.trim()}>
            Validar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** What an update changes, before applying it. */
function PreviewModal({
  text,
  content,
  opened,
  onClose,
  onApply,
}: {
  text: string;
  content: PlanContent;
  opened: Parameters<typeof parseImport>[2];
  onClose: () => void;
  onApply: (next: PlanContent, summary: string) => Promise<void>;
}) {
  const result = useMemo(
    () => parseImport(text, content, opened),
    [text, content, opened],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="O que muda no plano" onClose={onClose} busy={busy}>
      <div className="entity-form">
        {!result.ok ? (
          <p className="sl-alert bad">
            <CircleAlert size={15} />
            {result.error}
          </p>
        ) : (
          <>
            {result.summary && <p>{result.summary}</p>}
            {result.changes.length > 0 && (
              <ul className="sl-changes">
                {result.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            {result.content.posts
              .filter((p) =>
                result.changes.some((c) => c.startsWith(`Post ${p.numero}:`)),
              )
              .map((p) => {
                const before = content.posts.find(
                  (x) => x.numero === p.numero,
                )!;
                return (
                  <div key={p.numero} className="sl-diff">
                    <strong>Post {p.numero}</strong>
                    {(
                      [
                        "gancho",
                        "direcaoCopy",
                        "direcaoVisual",
                        "formato",
                        "cta",
                      ] as const
                    )
                      .filter((k) => before[k] !== p[k])
                      .map((k) => (
                        <p key={k}>
                          <del>{before[k]}</del>
                          <ins>{p[k]}</ins>
                        </p>
                      ))}
                  </div>
                );
              })}
            {result.warnings.map((w) => (
              <p key={w} className="sl-alert warn">
                <TriangleAlert size={15} />
                {w}
              </p>
            ))}
          </>
        )}
        {error && <p className="sl-alert bad">{error}</p>}
        <div className="form-footer">
          <Button className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            className="btn primary"
            disabled={!result.ok || !result.changes.length}
            loading={busy}
            onClick={() => {
              if (!result.ok) return;
              setBusy(true);
              setError("");
              onApply(result.content, result.summary)
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            Aplicar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ sections
/**
 * A paragraph read in layers: the first sentence stands out, the rest follows
 * and, when long, folds under "Ler mais" (nothing the AI wrote is cut).
 */
function Layered({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // "Ler mais" only when the folded text is really cut (width decides).
  const [cut, setCut] = useState(false);
  const restRef = useRef<HTMLParagraphElement>(null);
  const { lead, rest } = leadOf(text);
  useEffect(() => {
    const el = restRef.current;
    if (!el) return;
    const check = () =>
      setCut((c) => (open ? c : el.scrollHeight > el.clientHeight + 1));
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rest, open]);
  if (!lead) return <p className="sl-muted">—</p>;
  return (
    <div className={`sl-layered ${className}`}>
      <p className="sl-lead">{lead}</p>
      {rest && (
        <p ref={restRef} className={open ? "sl-rest" : "sl-rest folded"}>
          {rest}
        </p>
      )}
      {cut && (
        <button
          type="button"
          className="sl-link"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Mostrar menos" : "Ler mais"}
        </button>
      )}
    </div>
  );
}

const swotParts = [
  { key: "forcas", title: "Forças", tone: "good", icon: TrendingUp },
  { key: "fraquezas", title: "Fraquezas", tone: "bad", icon: TrendingDown },
  {
    key: "oportunidades",
    title: "Oportunidades",
    tone: "info",
    icon: Lightbulb,
  },
  { key: "ameacas", title: "Ameaças", tone: "warn", icon: ShieldAlert },
] as const;

/**
 * The strategy of the month, from the whole picture to the details: who the
 * client is, how they want to be seen and for whom, the four content pillars
 * and the SWOT as a matrix of short items.
 */
function Strategy({ content }: { content: PlanContent }) {
  return (
    <div className="sl-strategy">
      <section className="panel sl-st-hero">
        <span className="sl-eyebrow">Diagnóstico do negócio</span>
        <Layered text={content.diagnostico.negocio} />
      </section>
      <div className="sl-st-duo">
        <section className="panel sl-st-card">
          <h3>
            <Eye size={16} /> Como quer ser vista
          </h3>
          <Layered text={content.diagnostico.comoQuerSerVista} />
        </section>
        <section className="panel sl-st-card">
          <h3>
            <Users size={16} /> Para quem falamos
          </h3>
          <Layered text={content.publico} />
        </section>
      </div>
      <section className="sl-st-block">
        <header>
          <h3>Pilares de conteúdo</h3>
          <small>Os temas que os posts do mês alternam</small>
        </header>
        <ol className="sl-st-pillars">
          {content.pilares.map((p, i) => (
            <li key={p.titulo} className="panel">
              <span className="sl-st-num">{i + 1}</span>
              <strong>{p.titulo}</strong>
              <p>{p.descricao}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="sl-st-block">
        <header>
          <h3>SWOT</h3>
          <small>
            Forças e fraquezas: o negócio hoje. Oportunidades e ameaças: o
            mercado.
          </small>
        </header>
        <div className="sl-st-swot">
          {swotParts.map(({ key, title, tone, icon: Icon }) => {
            const { note, label, points } = pointsOf(content.swot[key]);
            return (
              <section key={key} className={`sl-st-quad ${tone}`}>
                <h4>
                  <Icon size={15} /> {title}
                  {!!points.length && <small>{points.length}</small>}
                </h4>
                {note && <p className="sl-st-note">{note}</p>}
                {label && <p className="sl-st-label">{label}:</p>}
                {points.length ? (
                  <ul>
                    {points.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ) : (
                  !note && <p className="sl-muted">—</p>
                )}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** One field of the campaign: the lead sentence, then its points or text. */
function CampaignDetail({ label, text }: { label: string; text: string }) {
  const { lead, rest } = leadOf(text);
  const { points } = pointsOf(rest);
  return (
    <div className="sl-cp-detail">
      <dt>{label}</dt>
      <dd>
        {lead ? (
          <p className="sl-lead">{lead}</p>
        ) : (
          <p className="sl-muted">—</p>
        )}
        {points.length >= 2 ? (
          <ul>
            {points.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : (
          rest && <p className="sl-rest">{rest}</p>
        )}
      </dd>
    </div>
  );
}

/**
 * The Meta campaign: the figures first (objective, budget, age, region),
 * then the path of a lead in three steps — who sees the ad, the ad itself,
 * and what happens when the lead arrives (the questions, ready to copy).
 */
function Campaign({
  content,
  objective,
  notify,
}: {
  content: PlanContent;
  objective: CampaignObjective | null;
  notify: (m: string) => void;
}) {
  const c = content.campanha;
  const ad = content.posts.find((p) => p.ehAnuncio);
  const facts = campaignFacts(c, objective);
  const icons = {
    objetivo: Target,
    verba: Wallet,
    publico: Users,
    regiao: MapPin,
  };
  // A CTWA plan puts the suggested first message among the questions.
  const opening = c.perguntasFormulario.find((q) =>
    /^mensagem inicial/i.test(q),
  );
  const questions = c.perguntasFormulario.filter((q) => q !== opening);
  const openingText = opening
    ?.replace(/^mensagem inicial[^:]*:\s*/i, "")
    .replace(/^['"“]|['"”]$/g, "");
  const whatsapp = objective === "ctwa" || !!opening;
  const copy = () =>
    navigator.clipboard
      .writeText(
        [
          openingText ? `Mensagem inicial: ${openingText}` : "",
          ...questions.map((q, i) => `${i + 1}. ${q}`),
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .then(
        () => notify("Perguntas copiadas."),
        () => notify("Não foi possível copiar. Selecione e copie à mão."),
      );
  return (
    <div className="sl-campaign">
      <div className="sl-cp-facts">
        {facts.map((f) => {
          const Icon = icons[f.key as keyof typeof icons];
          return (
            <div key={f.key} className="panel sl-cp-fact">
              <span>
                <Icon size={14} /> {f.label}
              </span>
              <strong>{f.value}</strong>
              {f.hint && <small>{f.hint}</small>}
            </div>
          );
        })}
      </div>

      <section className="panel sl-cp-step">
        <header>
          <span className="sl-st-num">1</span>
          <h3>Quem vê o anúncio</h3>
        </header>
        <dl className="sl-cp-grid">
          <CampaignDetail label="Região" text={c.regiao} />
          <CampaignDetail label="Idade e gênero" text={c.idadeGenero} />
          <CampaignDetail label="Segmentação" text={c.segmentacao} />
          <CampaignDetail label="Posicionamentos" text={c.posicionamentos} />
        </dl>
      </section>

      <section className="panel sl-cp-step">
        <header>
          <span className="sl-st-num">2</span>
          <h3>O anúncio</h3>
        </header>
        {ad && (
          <div className="sl-cp-ad">
            <span className="sl-pill ad">
              <Megaphone size={11} /> Post {ad.numero} vira o anúncio
            </span>
            <strong>{ad.gancho}</strong>
            <p>{ad.direcaoCopy}</p>
            <small>
              {ad.formato} · CTA: {ad.cta}
            </small>
          </div>
        )}
        <dl className="sl-cp-grid">
          <CampaignDetail label="Objetivo" text={c.objetivo} />
          <CampaignDetail label="Orçamento" text={c.orcamento} />
        </dl>
      </section>

      <section className="panel sl-cp-step">
        <header>
          <span className="sl-st-num">3</span>
          <h3>Quando o lead chega</h3>
        </header>
        {(openingText || questions.length > 0) && (
          <div className="sl-cp-questions">
            <div className="sl-cp-questions-head">
              <h4>
                <MessageCircle size={15} />{" "}
                {whatsapp
                  ? "Roteiro de qualificação no WhatsApp"
                  : "Perguntas do formulário"}
              </h4>
              <Button className="btn secondary" onClick={copy}>
                <Copy size={14} /> Copiar
              </Button>
            </div>
            {openingText && (
              <blockquote>
                <small>Mensagem inicial sugerida</small>“{openingText}”
              </blockquote>
            )}
            {questions.length > 0 && (
              <ol>
                {questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ol>
            )}
          </div>
        )}
        <dl className="sl-cp-grid one">
          <CampaignDetail
            label="Como o lead é atendido"
            text={c.roteamentoLead}
          />
        </dl>
      </section>
    </div>
  );
}
/**
 * The plan's alerts and the promise check, each with "Marcar como lido".
 * Who marked it and when stays saved (social_leads_alert_reads); a text
 * that changes comes back unread.
 */
function Alerts({
  content,
  flags,
  reads,
  who,
  onMark,
}: {
  content: PlanContent;
  flags: ReturnType<typeof complianceFlags>;
  reads: SlAlertRead[];
  who: (id: string | null) => string | undefined;
  onMark: (
    text: string,
    kind: SlAlertRead["kind"],
    read: boolean,
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  if (!content.alertas.length && !flags.length)
    return (
      <Empty
        title="Sem alertas"
        body="A MAVI não apontou bloqueios nem riscos neste plano."
      />
    );
  const readOf = (text: string) => reads.find((r) => r.alert_text === text);
  const all = content.alertas.length + flags.length;
  const done =
    content.alertas.filter((a) => readOf(a)).length +
    flags.filter((f) => readOf(flagText(f))).length;
  const mark = (text: string, kind: SlAlertRead["kind"], read: boolean) => {
    setBusy(text);
    void onMark(text, kind, read).finally(() => setBusy(""));
  };
  const readToggle = (text: string, kind: SlAlertRead["kind"]) => {
    const r = readOf(text);
    return (
      <span className="sl-alert-read">
        <button
          type="button"
          role="checkbox"
          aria-checked={!!r}
          className={`sl-read-toggle${r ? " on" : ""}`}
          disabled={busy === text}
          title={r ? "Marcar como não lido" : "Marcar como lido"}
          onClick={() => mark(text, kind, !r)}
        >
          <span className="sl-read-box" aria-hidden="true">
            {r && <Check size={11} strokeWidth={3.2} />}
          </span>
          {r ? "Lido" : "Marcar como lido"}
        </button>
        {r && (
          <small>
            {who(r.read_by)?.split(" ")[0] ?? "Alguém"} · {dateTime(r.read_at)}
          </small>
        )}
      </span>
    );
  };
  return (
    <div className="sl-alerts">
      <p className="sl-alerts-progress">
        <CircleCheck size={15} /> {done} de {all}{" "}
        {all === 1 ? "alerta lido" : "alertas lidos"}
        <span className="sl-meter" aria-hidden="true">
          <i style={{ width: `${Math.round((done / all) * 100)}%` }} />
        </span>
      </p>
      {content.alertas.map((a, i) => (
        <div
          key={a}
          className={`sl-alert sl-alert-item ${i === 0 && /^bloqueio/i.test(a) ? "bad" : "warn"}${readOf(a) ? " read" : ""}`}
        >
          {i === 0 && /^bloqueio/i.test(a) ? (
            <CircleAlert size={15} />
          ) : (
            <TriangleAlert size={15} />
          )}
          <span>{a}</span>
          {readToggle(a, "alerta")}
        </div>
      ))}
      {flags.length > 0 && (
        <section className="panel">
          <h3>Checagem de promessas nos posts</h3>
          <p className="sl-muted">
            Palavras que costumam virar promessa de resultado ou de ganho.
            Confira cada uma, inclusive os textos da imagem, do vídeo e a
            legenda.
          </p>
          <ul className="sl-flag-list">
            {flags.map((f) => {
              const text = flagText(f);
              return (
                <li
                  key={`${f.post}${f.field}${f.term}`}
                  className={readOf(text) ? "read" : ""}
                >
                  <span>
                    Post {f.post} · {f.field}: “{f.term}”, {f.why}
                  </span>
                  {readToggle(text, "checagem")}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
function Revisions({
  bundle,
  canWrite,
  who,
  onRestore,
  notify,
}: {
  bundle: PlanBundle;
  canWrite: boolean;
  who: (id: string | null) => string | undefined;
  onRestore: (id: string) => Promise<void>;
  notify: (m: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!bundle.revisions.length)
    return (
      <Empty
        title="Nenhuma versão anterior"
        body="Antes de regenerar, importar, editar ou restaurar, o plano vigente fica guardado aqui."
      />
    );
  return (
    <section className="panel sl-revisions">
      <ul>
        {bundle.revisions.map((r) => {
          const decided = r.content.posts.filter(
            (p) => p.status && p.status !== "pendente",
          ).length;
          const of = r.content.posts.length;
          return (
            <li key={r.id}>
              <History size={16} />
              <div>
                <strong>
                  Versão {r.number} · {maviText(r.reason)}
                </strong>
                <small>
                  {dateTime(r.created_at)}
                  {who(r.created_by) ? ` · ${who(r.created_by)}` : ""} ·{" "}
                  {decided} de {of} decididos
                </small>
              </div>
              {canWrite &&
                (confirm === r.id ? (
                  <span className="sl-confirm">
                    Restaurar esta versão?
                    <Button
                      className="btn primary"
                      loading={busy}
                      onClick={() => {
                        setBusy(true);
                        onRestore(r.id)
                          .catch((e) => notify((e as Error).message))
                          .finally(() => {
                            setBusy(false);
                            setConfirm(null);
                          });
                      }}
                    >
                      Restaurar
                    </Button>
                    <Button
                      className="btn secondary"
                      onClick={() => setConfirm(null)}
                    >
                      Cancelar
                    </Button>
                  </span>
                ) : (
                  <Button
                    className="btn secondary"
                    onClick={() => setConfirm(r.id)}
                  >
                    <RotateCcw size={15} /> Restaurar
                  </Button>
                ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The post's exact texts, each with a copy button (plain text). */
function PostTexts({
  post,
  notify,
}: {
  post: SlPost;
  notify: (m: string) => void;
}) {
  const shown = POST_TEXTS.filter((t) => postTextPlain(post[t.column]));
  if (!shown.length)
    return (
      <p className="sl-muted sl-post-texts-empty">
        Sem os textos exatos da peça (plano anterior a eles). Use “Editar post”
        ou “Pedir ajuste à MAVI” para escrever o texto da imagem, do vídeo e a
        legenda.
      </p>
    );
  return (
    <div className="sl-post-texts">
      {shown.map((t) => (
        <section key={t.key}>
          <header>
            <strong>{t.label}</strong>
            <button
              type="button"
              className="sl-link"
              onClick={() =>
                navigator.clipboard
                  .writeText(postTextPlain(post[t.column]))
                  .then(
                    () => notify(`${t.label} copiado.`),
                    () => notify("Não foi possível copiar."),
                  )
              }
            >
              <Copy size={13} /> Copiar
            </button>
          </header>
          <RichTextContent value={post[t.column] ?? ""} />
        </section>
      ))}
    </div>
  );
}
