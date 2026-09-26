import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Megaphone, MessageSquare, X } from "lucide-react";
import { Button, Textarea } from "./ui";
import {
  serverLink,
  type LinkSource,
  type SharedPlan,
} from "./social-leads-api";
import { pillars } from "./social-leads";

type Post = SharedPlan["posts"][number];

/**
 * The plan of the month opened by the client from the approval link
 * (/aprovacao/<token>), without signing in. Made for the phone first: a
 * progress bar that stays on top (with a shortcut to the next post to
 * decide), one card per post with big buttons, and after each decision the
 * page moves on to the next pending post. Shows only what the B29's
 * presentation PDF showed (no alerts, budget or internal details).
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
  const cards = useRef(new Map<number, HTMLElement>());
  const load = () =>
    source
      .load(token)
      .then((p) => {
        setPlan(p);
        if (!embedded) document.title = `${p.label} · ${p.client}`;
        return p;
      })
      .catch(() => {
        setError(
          "Este link não está mais ativo. Peça um novo link para a equipe.",
        );
        return null;
      });
  useEffect(() => {
    void load();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = (numero: number) =>
    cards.current.get(numero)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });

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
  const nextPending = plan.posts.find((p) => p.decision === "pending");
  const total = plan.posts.length;

  return (
    <main className={`sl-public${embedded ? " embedded" : ""}`}>
      <header className="sl-public-head">
        <div className="sl-public-inner">
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
            {total} publicações · criado em{" "}
            {new Date(plan.created_at).toLocaleDateString("pt-BR")}
            {plan.responsible ? ` · com ${plan.responsible}` : ""}
          </p>
        </div>
      </header>

      <nav className="sl-public-bar" aria-label="Andamento da aprovação">
        <div className="sl-public-inner">
          <div className="sl-public-progress">
            {plan.posts.map((p) => (
              <button
                key={p.numero}
                type="button"
                className={p.decision}
                aria-label={`Post ${p.numero}: ${
                  p.decision === "approved"
                    ? "aprovado"
                    : p.decision === "rejected"
                      ? "ajuste pedido"
                      : "pendente"
                }`}
                onClick={() => goTo(p.numero)}
              />
            ))}
          </div>
          <div className="sl-public-bar-row">
            <span>
              <strong>
                {decided} de {total}
              </strong>{" "}
              decididos
            </span>
            {nextPending && (
              <button
                type="button"
                className="sl-public-next"
                onClick={() => goTo(nextPending.numero)}
              >
                Ir para o post {nextPending.numero}
              </button>
            )}
          </div>
        </div>
      </nav>

      <div className="sl-public-inner sl-public-list">
        <details className="sl-public-intro">
          <summary>
            <span>
              <strong>O que vamos comunicar</strong>
              <small>
                {plan.pilares.length} pilares · para quem é o conteúdo
              </small>
            </span>
            <ChevronDown size={18} aria-hidden="true" />
          </summary>
          {plan.diagnostico?.comoQuerSerVista && (
            <p>{plan.diagnostico.comoQuerSerVista}</p>
          )}
          <ol>
            {plan.pilares.map((p) => (
              <li key={p.titulo}>
                <strong>{p.titulo}</strong>
                <span>{p.descricao}</span>
              </li>
            ))}
          </ol>
          <p className="sl-muted">Para quem: {plan.publico}</p>
        </details>

        {decided === total && (
          <section className="sl-public-done" role="status">
            <Check size={20} />
            <div>
              <strong>Pronto! Você decidiu os {total} posts.</strong>
              <span>
                {approved} {approved === 1 ? "aprovado" : "aprovados"}
                {total - approved
                  ? ` e ${total - approved} com ajuste pedido`
                  : ""}
                . A equipe já recebeu suas respostas. Ainda dá para mudar
                qualquer decisão.
              </span>
            </div>
          </section>
        )}

        {plan.posts.map((p) => (
          <PublicPost
            key={p.numero}
            ref={(el) => {
              if (el) cards.current.set(p.numero, el);
              else cards.current.delete(p.numero);
            }}
            token={token}
            post={p}
            total={total}
            source={source}
            onDecided={async () => {
              const fresh = await load();
              const next =
                fresh?.posts.find(
                  (x) => x.decision === "pending" && x.numero > p.numero,
                ) ?? fresh?.posts.find((x) => x.decision === "pending");
              if (next) window.setTimeout(() => goTo(next.numero), 250);
            }}
          />
        ))}

        <section className="sl-public-intro sl-public-ad">
          <h2>
            <Megaphone size={16} /> O anúncio do mês
          </h2>
          <p>
            {[
              plan.campanha.objetivo,
              plan.campanha.regiao,
              plan.campanha.idadeGenero,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </section>
        <footer className="sl-public-foot">
          Suas respostas chegam direto para a equipe.
        </footer>
      </div>
    </main>
  );
}

function PublicPost({
  ref,
  token,
  post,
  total,
  source,
  onDecided,
}: {
  ref: (el: HTMLElement | null) => void;
  token: string;
  post: Post;
  total: number;
  source: LinkSource;
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
      .then(() => {
        setAsking(false);
        setChanging(false);
        return onDecided();
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
    <article
      ref={ref}
      className={`sl-public-post ${post.decision}`}
      aria-label={`Post ${post.numero} de ${total}`}
    >
      <div className="sl-post-top">
        <span className="sl-num">
          Post {post.numero}
          <span className="sl-public-of"> de {total}</span>
        </span>
        <span className={`sl-pill ${post.badge}`}>{pillars[post.badge]}</span>
        {post.ehAnuncio && (
          <span className="sl-pill ad">
            <Megaphone size={11} /> Vira anúncio
          </span>
        )}
      </div>
      <h3>{post.gancho}</h3>
      {!!post.arts?.length && (
        <div className={`sl-public-arts n${Math.min(post.arts.length, 4)}`}>
          {post.arts.slice(0, 4).map((a) =>
            a.type.startsWith("video/") ? (
              <video
                key={a.id}
                src={source.artUrl(token, a)}
                controls
                playsInline
                preload="metadata"
              />
            ) : a.type.startsWith("image/") ? (
              <a
                key={a.id}
                href={source.artUrl(token, a)}
                target="_blank"
                rel="noreferrer"
                aria-label={`Ver ${a.name}`}
              >
                <img
                  src={source.artUrl(token, a)}
                  alt={`Arte do post ${post.numero}`}
                  loading="lazy"
                />
              </a>
            ) : (
              <a
                key={a.id}
                className="sl-public-file"
                href={source.artUrl(token, a)}
                target="_blank"
                rel="noreferrer"
              >
                {a.name}
              </a>
            ),
          )}
          {post.arts.length > 4 && (
            <small>+{post.arts.length - 4} arquivos</small>
          )}
        </div>
      )}
      <p>{post.direcaoCopy}</p>
      <div className="sl-public-facts">
        <span>
          <small>Formato</small>
          {post.formato}
        </span>
        <span>
          <small>Chamada</small>
          {post.cta}
        </span>
      </div>
      <div className="sl-public-visual">
        <small>Como vai ser</small>
        <p>{post.direcaoVisual}</p>
      </div>
      {!open ? (
        <div className={`sl-public-decided ${post.decision}`}>
          <span>
            {post.decision === "approved" ? (
              <Check size={16} />
            ) : (
              <X size={16} />
            )}
            {post.decision === "approved"
              ? "Você aprovou"
              : "Você pediu ajuste"}
          </span>
          {post.note && <blockquote>{post.note}</blockquote>}
          <button
            type="button"
            className="sl-link"
            onClick={() => setChanging(true)}
          >
            Mudar minha resposta
          </button>
        </div>
      ) : asking ? (
        <div className="sl-public-ask">
          <label>
            O que você quer mudar neste post?
            <Textarea
              rows={3}
              autoFocus
              value={note}
              maxLength={2000}
              placeholder="Ex.: prefiro uma foto da fachada, e o texto mais curto."
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="sl-public-buttons">
            <Button
              className="btn primary"
              loading={busy}
              disabled={!note.trim()}
              onClick={() => decide("rejected")}
            >
              <MessageSquare size={16} /> Enviar ajuste
            </Button>
            <Button
              className="btn secondary"
              onClick={() => setAsking(false)}
              disabled={busy}
            >
              Voltar
            </Button>
          </div>
        </div>
      ) : (
        <div className="sl-public-buttons">
          <Button
            className="btn primary"
            loading={busy}
            onClick={() => decide("approved")}
          >
            <Check size={17} /> Aprovar este post
          </Button>
          <Button
            className="btn secondary"
            onClick={() => setAsking(true)}
            disabled={busy}
          >
            <X size={16} /> Pedir ajuste
          </Button>
          {changing && (
            <button
              type="button"
              className="sl-link"
              onClick={() => setChanging(false)}
            >
              Manter a resposta anterior
            </button>
          )}
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
