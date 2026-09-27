import { useCallback, useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { Loading } from "./ui";
import {
  HighlightTiles,
  LinkList,
  MediaGallery,
  NicheChips,
  TextList,
  type UrlLoader,
} from "./CaseParts";
import { sharedCase, sharedCaseMedia, type SharedCase } from "./cases";

/**
 * A case opened by its link (/cases/<token>), without the app and without
 * signing in: what the agency sends to a lead. The database only answers
 * for approved cases with the link on, and leaves out the client's name and
 * the contacts unless they were chosen.
 */
export function PublicCase({ token }: { token: string }) {
  const [state, setState] = useState<SharedCase | null | undefined>(undefined);
  useEffect(() => {
    sharedCase(token)
      .then((c) => {
        setState(c);
        if (c) document.title = `${c.title} · ${c.company}`;
      })
      .catch(() => setState(null));
  }, [token]);
  const loader: UrlLoader = useCallback(
    (ids, inline) => sharedCaseMedia(token, ids, inline),
    [token],
  );

  if (state === undefined)
    return (
      <main className="public-case centered-page">
        <Loading compact />
      </main>
    );
  if (!state)
    return (
      <main className="public-case centered-page">
        <div className="panel public-case-message">
          <Trophy size={28} />
          <h1>Case indisponível</h1>
          <p>Este link não existe mais ou foi desligado por quem o enviou.</p>
        </div>
      </main>
    );
  return (
    <main className="public-case">
      <header className="public-case-bar">
        <span>{state.company}</span>
        <small>Case de sucesso</small>
      </header>
      <article className="public-case-body">
        <header className="case-hero">
          {state.client && <span className="case-kicker">{state.client}</span>}
          <h1>{state.title}</h1>
          <NicheChips niches={state.niches} />
        </header>
        <HighlightTiles items={state.highlights} />
        {state.summary && <p className="case-summary">{state.summary}</p>}
        {!!state.products.length && (
          <p className="public-case-products">
            Feito com {state.products.join(", ").replace(/, ([^,]*)$/, " e $1")}
          </p>
        )}
        <MediaGallery media={state.media} load={loader} />
        {!!state.links.length && (
          <section>
            <h2>Veja de perto</h2>
            <LinkList links={state.links} />
          </section>
        )}
        {!!state.contacts.length && (
          <section>
            <h2>Contato</h2>
            <TextList texts={state.contacts} />
          </section>
        )}
      </article>
      <footer className="public-case-foot">Enviado por {state.company}</footer>
    </main>
  );
}
