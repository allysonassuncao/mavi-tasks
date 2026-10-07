import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Archive, ArrowLeft, Building2, Copy, Palette, Pencil, Plus, Sparkles, Users } from "lucide-react";
import { Button, Loading } from "./ui";
import { Empty } from "./components";
import { IdentityEditor, IdentityPreview, MaviDraftForm, draftOf, newDraft, type IdentityDraft } from "./IdentityEditor";
import { archiveIdentity, getIdentity, listIdentities, type IdentityList } from "./identities";
import { BUILTIN_LOOKS, builtinLook, sanitizeTokens, type IdentityRow, type Look } from "./visual-identity";
import "./identities.css";

/**
 * MAVI › Identidades: a identidade da empresa e a galeria de estilos que a
 * MAVI usa nos documentos e apresentações (a de cada cliente fica em Drive ›
 * cliente › Marca). Qualquer pessoa da empresa cria e edita; cada
 * salvamento é uma versão.
 */

const lookOf = (r: IdentityRow, source: Look["source"]): Look => ({
  ...sanitizeTokens(r.tokens),
  id: r.id,
  name: r.name,
  source,
});

export function IdentitiesPage({
  company,
  clients,
  notify,
}: {
  company: string;
  /** Os clientes que a pessoa atende (para usar logos e fontes da Marca deles). */
  clients: { id: string; name: string }[];
  notify: (message: string) => void;
}) {
  const [list, setList] = useState<IdentityList | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<IdentityDraft | null>(null);
  const [drafting, setDrafting] = useState<{ scope: "company" | "gallery"; current: IdentityDraft | null } | null>(null);
  const [notes, setNotes] = useState<string[] | undefined>(undefined);
  const load = useCallback(
    () =>
      listIdentities(company)
        .then(setList)
        .catch((e) => setError((e as Error).message)),
    [company],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    const r = await getIdentity(id).catch(() => null);
    if (r) setEditing(draftOf(r));
    else notify("Não foi possível abrir a identidade.");
  }
  async function archive(r: IdentityRow) {
    if (!window.confirm(`Tirar “${r.name}” da galeria? As versões ficam guardadas.`)) return;
    try {
      await archiveIdentity(r.id);
      await load();
      notify("Estilo tirado da galeria.");
    } catch (e) {
      notify((e as Error).message);
    }
  }

  if (error) return <Empty title="Identidades indisponíveis" body={error} />;
  if (!list) return <Loading variant="form" />;
  /** O editor e o "Gerar com a MAVI" abrem num painel com o título e a volta. */
  const frame = (title: string, description: string, body: ReactNode, back: () => void) => (
    <div className="identities-page">
      <div className="identities-toolbar">
        <Button className="btn secondary" onClick={back}>
          <ArrowLeft size={15} /> Identidades
        </Button>
      </div>
      <section className="panel identities-panel">
        <header className="identities-panel-head">
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </header>
        {body}
      </section>
    </div>
  );
  if (drafting)
    return frame(
      drafting.scope === "company" ? "Identidade da empresa com a MAVI" : "Novo estilo a partir de um site",
      "",
      <MaviDraftForm
        company={company}
        scope={drafting.scope}
        client={null}
        current={drafting.current}
        onCancel={() => setDrafting(null)}
        onDraft={(d, n) => {
          setDrafting(null);
          setNotes(n);
          setEditing(d);
        }}
      />,
      () => setDrafting(null),
    );
  if (editing)
    return frame(
      editing.id ? editing.name : editing.scope === "company" ? "Identidade da empresa" : "Novo estilo da galeria",
      editing.scope === "company"
        ? "A MAVI usa nos documentos e apresentações internos ou da agência (propostas, apresentações institucionais)."
        : "A MAVI sugere este estilo quando o documento não é de um cliente com marca.",
      <IdentityEditor
        company={company}
        initial={editing}
        clients={clients}
        maviNotes={notes}
        notify={notify}
        onSaved={() => {
          setNotes(undefined);
          void load();
        }}
        onCancel={() => {
          setEditing(null);
          setNotes(undefined);
        }}
      />,
      () => {
        setEditing(null);
        setNotes(undefined);
      },
    );

  const card = (
    key: string,
    look: Look,
    title: string,
    text: string,
    actions: ReactNode,
    badge?: string,
    wide = false,
  ) => (
    <li key={key} className={`panel identity-card${wide ? " wide" : ""}`}>
      <div className="identity-card-art">
        <IdentityPreview company={company} look={look} compact />
      </div>
      <div className="identity-card-body">
        <span className="identity-card-title">
          <strong title={title}>{title}</strong>
          {badge && <span className="identity-card-badge">{badge}</span>}
        </span>
        {text && <p>{text}</p>}
      </div>
      <div className="identity-card-actions">{actions}</div>
    </li>
  );

  return (
    <div className="identities-page">
      <div className="identities-toolbar">
        <p>
          A identidade da empresa vale para o material da agência; os estilos da galeria e os prontos, para o que não é
          de um cliente. A de cada cliente fica em Drive › cliente › Marca.
        </p>
        <Button className="btn secondary" onClick={() => setDrafting({ scope: "gallery", current: null })}>
          <Sparkles size={15} /> A partir de um site
        </Button>
        <Button className="btn primary" onClick={() => setEditing(newDraft("gallery", null))}>
          <Plus size={15} /> Novo estilo
        </Button>
      </div>

      <section className="identities-section">
        <h3>
          <Building2 size={15} aria-hidden="true" /> Identidade da empresa
        </h3>
        {list.company ? (
          <ul className="identities-grid single">
            {card(
              list.company.id,
              lookOf(list.company, "company"),
              list.company.name,
              list.company.description ||
                `Versão ${list.company.version}${list.company.updated_by_name ? ` · ${list.company.updated_by_name}` : ""}`,
              <>
                <Button className="btn secondary" onClick={() => void open(list.company!.id)}>
                  <Pencil size={14} /> Editar
                </Button>
                <Button
                  className="btn secondary"
                  onClick={() =>
                    void getIdentity(list.company!.id).then((r) => setDrafting({ scope: "company", current: r ? draftOf(r) : null }))
                  }
                >
                  <Sparkles size={14} /> Refazer com a MAVI
                </Button>
              </>,
              `v${list.company.version}`,
              true,
            )}
          </ul>
        ) : (
          <div className="panel identities-empty">
            <span className="identities-empty-icon" aria-hidden="true">
              <Building2 size={20} />
            </span>
            <span className="identities-empty-text">
              <strong>A empresa ainda não tem identidade</strong>
              <p>A MAVI monta a partir do site da agência (cores, fontes e tom), ou você cria do zero.</p>
            </span>
            <span className="identities-empty-actions">
              <Button className="btn secondary" onClick={() => setEditing(newDraft("company", null, { name: "Nossa identidade" }))}>
                <Plus size={15} /> Criar do zero
              </Button>
              <Button className="btn primary" onClick={() => setDrafting({ scope: "company", current: null })}>
                <Sparkles size={15} /> Gerar com a MAVI
              </Button>
            </span>
          </div>
        )}
      </section>

      <section className="identities-section">
        <h3>
          <Users size={15} aria-hidden="true" /> Galeria da equipe
          {list.gallery.length > 0 && <span className="identities-count">{list.gallery.length}</span>}
        </h3>
        {list.gallery.length ? (
          <ul className="identities-grid">
            {list.gallery.map((r) =>
              card(
                r.id,
                lookOf(r, "gallery"),
                r.name,
                r.description,
                <>
                  <Button className="btn secondary" onClick={() => void open(r.id)}>
                    <Pencil size={14} /> Editar
                  </Button>
                  <Button className="icon-btn identity-card-remove" aria-label={`Tirar ${r.name} da galeria`} title="Tirar da galeria" onClick={() => void archive(r)}>
                    <Archive size={15} />
                  </Button>
                </>,
              ),
            )}
          </ul>
        ) : (
          <div className="panel identities-empty">
            <span className="identities-empty-icon" aria-hidden="true">
              <Palette size={20} />
            </span>
            <span className="identities-empty-text">
              <strong>Nenhum estilo salvo ainda</strong>
              <p>Crie um, copie um dos prontos abaixo ou salve pelo canvas quando a MAVI sugerir um estilo.</p>
            </span>
          </div>
        )}
      </section>

      <section className="identities-section">
        <h3>
          <Sparkles size={15} aria-hidden="true" /> Estilos prontos
        </h3>
        <ul className="identities-grid">
          {Object.entries(BUILTIN_LOOKS).map(([key, b]) =>
            card(
              key,
              builtinLook(key)!,
              b.name,
              b.description,
              <Button
                className="btn secondary"
                onClick={() =>
                  setEditing(newDraft("gallery", null, { name: `${b.name} (cópia)`, description: b.description, tokens: structuredClone(b.tokens) }))
                }
              >
                <Copy size={14} /> Copiar para a galeria
              </Button>,
            ),
          )}
        </ul>
      </section>
    </div>
  );
}
