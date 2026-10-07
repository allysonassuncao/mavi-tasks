import { useCallback, useEffect, useState } from "react";
import { Archive, Copy, Pencil, Plus, Sparkles } from "lucide-react";
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
  if (drafting)
    return (
      <section className="panel identities-page">
        <header className="identities-section">
          <h2>
            <Sparkles size={16} aria-hidden="true" />{" "}
            {drafting.scope === "company" ? "Identidade da empresa com a MAVI" : "Novo estilo a partir de um site"}
          </h2>
        </header>
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
        />
      </section>
    );
  if (editing)
    return (
      <section className="panel identities-page">
        <header className="identities-section">
          <h2>
            {editing.id ? editing.name : editing.scope === "company" ? "Identidade da empresa" : "Novo estilo da galeria"}
          </h2>
          <p>
            {editing.scope === "company"
              ? "A MAVI usa nos documentos e apresentações internos ou da agência (propostas, apresentações institucionais)."
              : "A MAVI sugere este estilo quando o documento não é de um cliente com marca."}
          </p>
        </header>
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
        />
      </section>
    );

  return (
    <div className="identities-page">
      <section className="panel identities-section">
        <h2>Identidade da empresa</h2>
        <p>
          A da sua agência: a MAVI usa em propostas, apresentações institucionais e material interno. As de cada
          cliente ficam em Drive › cliente › Marca (Guia da marca).
        </p>
        {list.company ? (
          <div className="identities-grid">
            <article className="identity-card">
              <IdentityPreview company={company} look={lookOf(list.company, "company")} compact />
              <div className="identity-card-body">
                <strong>{list.company.name}</strong>
                <small>
                  Versão {list.company.version}
                  {list.company.updated_by_name ? ` · ${list.company.updated_by_name}` : ""}
                </small>
              </div>
              <div className="identity-card-actions">
                <Button className="btn secondary" onClick={() => void open(list.company!.id)}>
                  <Pencil size={13} /> Editar
                </Button>
                <Button
                  className="btn secondary"
                  onClick={() =>
                    void getIdentity(list.company!.id).then((r) => setDrafting({ scope: "company", current: r ? draftOf(r) : null }))
                  }
                >
                  <Sparkles size={13} /> Refazer com a MAVI
                </Button>
              </div>
            </article>
          </div>
        ) : (
          <div className="identities-grid">
            <button type="button" className="identity-new" onClick={() => setDrafting({ scope: "company", current: null })}>
              <Sparkles size={18} /> Gerar com a MAVI (a partir do site)
            </button>
            <button type="button" className="identity-new" onClick={() => setEditing(newDraft("company", null, { name: "Nossa identidade" }))}>
              <Plus size={18} /> Criar do zero
            </button>
          </div>
        )}
      </section>

      <section className="panel identities-section">
        <h2>Galeria da equipe</h2>
        <p>
          Estilos que a equipe salvou (também pelo canvas, quando a MAVI sugere um). A MAVI oferece estes quando o
          documento não tem marca.
        </p>
        <div className="identities-grid">
          <button type="button" className="identity-new" onClick={() => setEditing(newDraft("gallery", null))}>
            <Plus size={18} /> Novo estilo
          </button>
          <button type="button" className="identity-new" onClick={() => setDrafting({ scope: "gallery", current: null })}>
            <Sparkles size={18} /> A partir de um site, com a MAVI
          </button>
          {list.gallery.map((r) => (
            <article key={r.id} className="identity-card">
              <IdentityPreview company={company} look={lookOf(r, "gallery")} compact />
              <div className="identity-card-body">
                <strong>{r.name}</strong>
                {r.description && <small>{r.description}</small>}
              </div>
              <div className="identity-card-actions">
                <Button className="btn secondary" onClick={() => void open(r.id)}>
                  <Pencil size={13} /> Editar
                </Button>
                <Button className="icon-btn" aria-label={`Tirar ${r.name} da galeria`} onClick={() => void archive(r)}>
                  <Archive size={14} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel identities-section">
        <h2>Estilos prontos</h2>
        <p>Os que já vêm com a MAVI. Para mudar um, copie para a galeria e edite.</p>
        <div className="identities-grid">
          {Object.entries(BUILTIN_LOOKS).map(([key, b]) => (
            <article key={key} className="identity-card">
              <IdentityPreview company={company} look={builtinLook(key)!} compact />
              <div className="identity-card-body">
                <strong>{b.name}</strong>
                <small>{b.description}</small>
              </div>
              <div className="identity-card-actions">
                <Button
                  className="btn secondary"
                  onClick={() =>
                    setEditing(newDraft("gallery", null, { name: `${b.name} (cópia)`, description: b.description, tokens: structuredClone(b.tokens) }))
                  }
                >
                  <Copy size={13} /> Copiar para a galeria
                </Button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
