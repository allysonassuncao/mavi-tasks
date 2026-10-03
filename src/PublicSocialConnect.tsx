import { useEffect, useState } from "react";
import { Check, CircleAlert, PlugZap } from "lucide-react";
import { Button } from "./ui";
import { smLink, type SmLinkInfo } from "./social-leads-api";
import type { SmPage } from "./social-leads";
import { PageList } from "./SocialMediaSchedule";
import "./social-leads-onboarding.css";
import "./social-media-schedule.css";

const RESULTS: Record<string, string> = {
  cancelado:
    "A entrada com o Facebook foi cancelada. Tente de novo quando quiser.",
  "sem-paginas":
    "Esse Facebook não administra nenhuma Página. Entre com o perfil que administra a Página da empresa.",
  erro: "Não foi possível conectar agora. Tente de novo.",
};

/**
 * /conectar/<token>: the client connects their Facebook Page (and the
 * Instagram linked to it) so the agency's scheduled posts go out by
 * themselves (Planejamento › Social Media › Agendamento). Without signing
 * in to the MAVI: the link is the permission, and the Facebook login is the
 * client's own, through the Social Media's Meta app.
 */
export function PublicSocialConnect({ token }: { token: string }) {
  const params = new URLSearchParams(window.location.search);
  const [pending] = useState(params.get("pendente") ?? "");
  const result = params.get("resultado") ?? "";
  const [info, setInfo] = useState<SmLinkInfo | null>(null);
  const [pages, setPages] = useState<{
    fb_user_name: string;
    pages: SmPage[];
  } | null>(null);
  const [page, setPage] = useState("");
  const [error, setError] = useState(
    result ? (RESULTS[result] ?? RESULTS.erro) : "",
  );
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const load = () =>
    smLink
      .info(token)
      .then((i) => {
        setInfo(i);
        document.title = `Conectar redes · ${i.client}`;
      })
      .catch(() => setGone(true));
  useEffect(() => {
    void load();
    if (pending)
      smLink
        .pending(token, pending)
        .then((p) => {
          setPages(p);
          if (p.pages.length === 1) setPage(p.pages[0].id);
        })
        .catch((e) => setError((e as Error).message));
    // The query (pendente, resultado) is not for sharing.
    if (pending || result)
      window.history.replaceState(null, "", `/conectar/${token}`);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (gone)
    return (
      <main className="sl-public centered-page">
        <div className="panel sl-public-message">
          <h1>Link indisponível</h1>
          <p>Este link não está mais ativo. Peça um novo link para a equipe.</p>
        </div>
      </main>
    );
  if (!info)
    return (
      <main className="sl-public centered-page" aria-busy="true">
        <p className="sl-muted">Carregando…</p>
      </main>
    );

  const login = () => {
    setBusy(true);
    setError("");
    smLink
      .connect(token)
      .then((url) => window.location.assign(url))
      .catch((e) => {
        setError((e as Error).message);
        setBusy(false);
      });
  };

  return (
    <main className="sl-public sm-connect">
      <header className="sl-public-head">
        <div className="sl-public-inner">
          <div className="sl-public-brand">
            {info.company_logo ? (
              <img src={info.company_logo} alt="" />
            ) : (
              <span className="brand-mark">
                {info.company.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span>{info.company}</span>
          </div>
          <p className="eyebrow">Publicação dos posts</p>
          <h1>{info.client}</h1>
          <p>
            Conecte a Página do Facebook da empresa (e o Instagram ligado a ela)
            para os posts aprovados saírem sozinhos, na data combinada.
          </p>
        </div>
      </header>
      <div className="sl-public-inner sl-public-list">
        {error && (
          <p className="sl-alert bad">
            <CircleAlert size={15} /> {error}
          </p>
        )}
        {done || (info.connected && !pages) ? (
          <section className="sl-public-done" role="status">
            <Check size={20} />
            <div>
              <strong>
                Conectado: {info.page_name}
                {info.ig_username ? ` · @${info.ig_username}` : ""}
              </strong>
              <span>
                Pronto! A equipe já pode publicar os posts agendados. Para
                trocar a Página, entre com o Facebook de novo.
              </span>
            </div>
          </section>
        ) : null}
        {pages && !done ? (
          <section className="sl-public-intro">
            <h2>Qual é a Página da {info.client}?</h2>
            <p className="sl-muted">
              Páginas que {pages.fb_user_name || "você"} administra. Os posts
              saem nela e no Instagram ligado a ela.
            </p>
            <PageList pages={pages.pages} value={page} onChange={setPage} />
            <Button
              className="btn primary"
              loading={busy}
              disabled={!page}
              onClick={() => {
                setBusy(true);
                setError("");
                smLink
                  .choose(token, pending, page)
                  .then(() => load())
                  .then(() => {
                    setDone(true);
                    setPages(null);
                  })
                  .catch((e) => setError((e as Error).message))
                  .finally(() => setBusy(false));
              }}
            >
              <PlugZap size={15} /> Conectar esta Página
            </Button>
          </section>
        ) : (
          <section className="sl-public-intro">
            <h2>Como funciona</h2>
            <ol className="sm-connect-steps">
              <li>
                Entre com o Facebook de quem administra a Página da empresa.
              </li>
              <li>
                Autorize a publicação na Página e no Instagram. O Instagram
                precisa ser uma conta profissional ligada à Página.
              </li>
              <li>Escolha a Página da {info.client}. Pronto.</li>
            </ol>
            <p className="sl-muted">
              A equipe só publica os posts que você aprovou, nas datas
              combinadas. Você pode tirar o acesso quando quiser, nas
              configurações do Facebook (Integrações comerciais).
            </p>
            <Button className="btn primary" loading={busy} onClick={login}>
              <PlugZap size={15} />{" "}
              {info.connected
                ? "Trocar a Página (entrar de novo)"
                : "Entrar com o Facebook"}
            </Button>
          </section>
        )}
        <footer className="sl-public-foot">
          {info.company} · conexão segura pelo Facebook
        </footer>
      </div>
    </main>
  );
}
