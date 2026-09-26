import { useEffect, useState } from "react";
import { Check, Megaphone, X } from "lucide-react";
import { Button, Textarea } from "./ui";
import {
  serverLink,
  type LinkSource,
  type SharedPlan,
} from "./social-leads-api";
import { pillars } from "./social-leads";

/**
 * The plan of the month opened by the client from the approval link
 * (/aprovacao/<token>), without signing in: the diagnosis, the pillars and
 * the 8 posts, each approved or sent back with a comment. Shows only what
 * the B29's presentation PDF showed (no alerts, budget or internal details).
 */
export function PublicSocialLeads({
  token,
  source = serverLink,
  embedded = false,
}: {
  token: string;
  source?: LinkSource;
  /** Shown inside the app ("Ver como o cliente"), not as its own page. */
  embedded?: boolean;
}) {
  const [plan, setPlan] = useState<SharedPlan | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    source
      .load(token)
      .then((p) => {
        setPlan(p);
        if (!embedded) document.title = `${p.label} · ${p.client}`;
      })
      .catch(() =>
        setError(
          "Este link não está mais ativo. Peça um novo link para a equipe.",
        ),
      );
  useEffect(() => {
    void load();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error)
    return (
      <main className="sl-public centered-page">
        <div className="panel sl-public-message">
          <h1>Link indisponível</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  if (!plan)
    return (
      <main className="sl-public centered-page" aria-busy="true">
        <p className="sl-muted">Carregando o plano…</p>
      </main>
    );

  const decided = plan.posts.filter((p) => p.decision !== "pending").length;
  const approved = plan.posts.filter((p) => p.decision === "approved").length;
  return (
    <main className={`sl-public${embedded ? " embedded" : ""}`}>
      <header className="sl-public-head">
        <div className="sl-public-brand">
          {plan.company_logo ? (
            <img src={plan.company_logo} alt="" />
          ) : (
            <span className="brand-mark">
              {plan.company.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span>{plan.company}</span>
        </div>
        <p className="eyebrow">Plano de conteúdo · {plan.label}</p>
        <h1>{plan.client}</h1>
        <p>
          {plan.posts.length} publicações · criado em{" "}
          {new Date(plan.created_at).toLocaleDateString("pt-BR")}
          {plan.responsible ? ` · com ${plan.responsible}` : ""}
        </p>
        <div
          className="sl-public-progress"
          aria-label={`${decided} de 8 posts decididos`}
        >
          {plan.posts.map((p) => (
            <i key={p.numero} className={p.decision} />
          ))}
        </div>
        <small>
          {decided === 8
            ? `Pronto! Você decidiu os 8 posts (${approved} aprovados).`
            : `${decided} de 8 decididos. Aprove ou peça ajuste em cada post.`}
        </small>
      </header>

      <section className="sl-public-intro">
        <h2>O que vamos comunicar</h2>
        <p>{plan.diagnostico?.comoQuerSerVista}</p>
        <ol>
          {plan.pilares.map((p) => (
            <li key={p.titulo}>
              <strong>{p.titulo}</strong>
              <span>{p.descricao}</span>
            </li>
          ))}
        </ol>
        <p className="sl-muted">Para quem: {plan.publico}</p>
      </section>

      {plan.posts.map((p) => (
        <PublicPost
          key={p.numero}
          token={token}
          post={p}
          source={source}
          onDecided={load}
        />
      ))}

      <section className="sl-public-intro">
        <h2>O anúncio do mês</h2>
        <p>
          {plan.campanha.objetivo}
          {plan.campanha.regiao ? ` · ${plan.campanha.regiao}` : ""}
          {plan.campanha.idadeGenero ? ` · ${plan.campanha.idadeGenero}` : ""}
        </p>
      </section>
      <footer className="sl-public-foot">
        Suas respostas chegam direto para a equipe.
      </footer>
    </main>
  );
}

function PublicPost({
  token,
  post,
  source,
  onDecided,
}: {
  token: string;
  source: LinkSource;
  post: SharedPlan["posts"][number];
  onDecided: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decide = (decision: "approved" | "rejected") => {
    setBusy(true);
    setError("");
    source
      .decide(token, post.numero, decision, decision === "rejected" ? note : "")
      .then(onDecided)
      .then(() => {
        setAsking(false);
        setChanging(false);
      })
      .catch((e) =>
        setError(
          (e as Error).message || "Não foi possível registrar. Tente de novo.",
        ),
      )
      .finally(() => setBusy(false));
  };
  const open = post.decision === "pending" || changing;
  return (
    <article className={`sl-public-post ${post.decision}`}>
      <div className="sl-post-top">
        <span className="sl-num">Post {post.numero}</span>
        <span className={`sl-pill ${post.badge}`}>{pillars[post.badge]}</span>
        {post.ehAnuncio && (
          <span className="sl-pill ad">
            <Megaphone size={11} /> Vira anúncio
          </span>
        )}
      </div>
      <h3>{post.gancho}</h3>
      <p>{post.direcaoCopy}</p>
      <dl>
        <dt>Formato</dt>
        <dd>{post.formato}</dd>
        <dt>Como vai ser</dt>
        <dd>{post.direcaoVisual}</dd>
        <dt>Chamada</dt>
        <dd>{post.cta}</dd>
      </dl>
      {!open ? (
        <div className={`sl-decided ${post.decision}`}>
          {post.decision === "approved" ? <Check size={16} /> : <X size={16} />}
          {post.decision === "approved" ? "Aprovado" : "Ajuste pedido"}
          {post.note && <blockquote>{post.note}</blockquote>}
          <button
            type="button"
            className="sl-link"
            onClick={() => setChanging(true)}
          >
            Mudar
          </button>
        </div>
      ) : asking ? (
        <div className="sl-public-ask">
          <Textarea
            rows={3}
            autoFocus
            value={note}
            maxLength={2000}
            placeholder="O que você quer mudar neste post?"
            onChange={(e) => setNote(e.target.value)}
            aria-label={`Ajuste do post ${post.numero}`}
          />
          <div className="sl-public-buttons">
            <Button
              className="btn secondary"
              onClick={() => setAsking(false)}
              disabled={busy}
            >
              Voltar
            </Button>
            <Button
              className="btn primary"
              loading={busy}
              disabled={!note.trim()}
              onClick={() => decide("rejected")}
            >
              Enviar ajuste
            </Button>
          </div>
        </div>
      ) : (
        <div className="sl-public-buttons">
          <Button
            className="btn secondary"
            onClick={() => setAsking(true)}
            disabled={busy}
          >
            <X size={15} /> Pedir ajuste
          </Button>
          <Button
            className="btn primary"
            loading={busy}
            onClick={() => decide("approved")}
          >
            <Check size={15} /> Aprovar
          </Button>
        </div>
      )}
      {error && (
        <p className="sl-alert bad" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
