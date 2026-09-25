import { useEffect, useState } from "react";
import { ClipboardList, Trash2, TriangleAlert } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { Modal } from "./components";
import {
  shortDate,
  type AdsBackend,
  type FacebookPage,
  type LeadForm,
  type LinkedLeadForm,
} from "./campaigns";

/**
 * "Integrar Formulário do Facebook?" (the MASO's cycle, edit v3): when a
 * cycle's Meta campaign collects leads with Facebook forms, each form must
 * send its leads to a Make capture page. Here: the Page (from the ones the
 * account's profile manages), its form, the capture page (the cycle's) and
 * the client's id in the Make; the server subscribes the Page to the app's
 * webhook (/api/meta-leadgen), which delivers every lead.
 */

const OTHER = "__other";

export function LeadFormAsk({
  onStart,
  onClose,
}: {
  onStart: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Integrar Formulário do Facebook?" onClose={onClose}>
      <div className="entity-form">
        <p>
          Esta campanha do Facebook tem o objetivo de <strong>cadastros</strong>{" "}
          (formulário do Facebook). Para os cadastros chegarem à Make, o
          formulário precisa estar integrado com uma página de captura da Make.
        </p>
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose}>
            Agora não
          </Button>
          <Button type="button" className="btn primary" onClick={onStart}>
            Sim, integrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function LeadFormIntegration({
  ads,
  company,
  account,
  client,
  landingPages,
  linked,
  onClose,
  onChanged,
}: {
  ads: AdsBackend;
  company: string;
  /** The cycle's ad account whose Facebook profile manages the Page. */
  account: string;
  client: { id: string; name: string } | null;
  /** The cycle's "Páginas de captura da Make". */
  landingPages: string[];
  /** The client's forms already linked. */
  linked: LinkedLeadForm[];
  onClose: () => void;
  /** done: the form was linked (the window closes). */
  onChanged: (message: string, done: boolean) => void;
}) {
  const [pages, setPages] = useState<FacebookPage[] | null>(null);
  const [page, setPage] = useState("");
  const [typedPage, setTypedPage] = useState("");
  const [forms, setForms] = useState<LeadForm[] | null>(null);
  const [pageName, setPageName] = useState("");
  const [form, setForm] = useState("");
  const [landing, setLanding] = useState(landingPages[0] ?? OTHER);
  const [typedLanding, setTypedLanding] = useState("");
  // The client's id in the Make: an earlier link's, or the name the MASO
  // import gave the client (its MASO id).
  const [makeUser, setMakeUser] = useState(
    linked[0]?.make_user_id ??
      (client && /^\d{1,20}$/.test(client.name.trim())
        ? client.name.trim()
        : ""),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    ads
      .pages(company, account)
      .then((list) => {
        if (!live) return;
        setPages(list);
        if (list.length === 1) setPage(list[0].id);
        if (!list.length) setPage(OTHER);
      })
      .catch((e) => {
        if (!live) return;
        setPages([]);
        setPage(OTHER);
        setError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [ads, company, account]);

  const pageId = page === OTHER ? typedPage.trim() : page;
  useEffect(() => {
    setForms(null);
    setForm("");
    if (!/^\d{5,30}$/.test(pageId)) return;
    let live = true;
    ads
      .forms(company, account, pageId)
      .then((r) => {
        if (!live) return;
        setForms(r.forms);
        setPageName(r.page.name);
        const active = r.forms.filter((f) => f.active);
        if (active.length === 1) setForm(active[0].id);
        setError("");
      })
      .catch((e) => {
        if (!live) return;
        setForms([]);
        setError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [ads, company, account, pageId]);

  const landingId = landing === OTHER ? typedLanding.trim() : landing;
  const chosen = forms?.find((f) => f.id === form);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await ads.linkForm(company, {
        account,
        page: pageId,
        form,
        form_name: chosen?.name ?? "",
        client: client?.id ?? null,
        landing_page: landingId,
        make_user: makeUser.trim(),
      });
      onChanged(
        `Formulário “${chosen?.name ?? form}” integrado com a página de captura ${landingId}.`,
        true,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (f: LinkedLeadForm) => {
    setBusy(true);
    try {
      await ads.unlinkForm(f.id);
      onChanged(
        `Integração do formulário “${f.form_name || f.form_id}” removida.`,
        false,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Integração do Formulário do Facebook"
      onClose={() => !busy && onClose()}
      busy={busy}
    >
      <div className="entity-form campaign-lead-forms">
        {linked.length > 0 && (
          <section aria-label="Formulários integrados">
            <h4>Já integrados{client ? ` · ${client.name}` : ""}</h4>
            <ul className="campaign-lead-list">
              {linked.map((f) => (
                <li key={f.id}>
                  <ClipboardList size={15} />
                  <span>
                    <strong>{f.form_name || f.form_id}</strong>
                    <small className="cell-note">
                      {f.page_name || `Página ${f.page_id}`} → página de captura{" "}
                      {f.landing_page_id}
                      {f.source === "maso" ? " · veio do MASO" : ""}
                      {" · "}
                      {f.last_lead_at
                        ? `último cadastro ${shortDate(f.last_lead_at.slice(0, 10))}, ${f.sent_30d} em 30 dias`
                        : "nenhum cadastro ainda"}
                    </small>
                    {f.last_error && (
                      <small className="danger-text">
                        <TriangleAlert size={12} /> {f.last_error.message}
                      </small>
                    )}
                  </span>
                  <Button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remover a integração de ${f.form_name || f.form_id}`}
                    title="Remover a integração"
                    disabled={busy}
                    onClick={() => void remove(f)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="cell-note">
          Os cadastros do formulário vão para a página de captura da Make (como
          no MASO). A página do Facebook é inscrita para enviar cada cadastro ao
          MAVI assim que ele acontece.
        </p>
        <label>
          Página do Facebook
          {pages === null ? (
            <Loading compact />
          ) : (
            <Select
              value={page}
              onValueChange={setPage}
              aria-label="Página do Facebook"
            >
              {!page && <SelectOption value="">Selecione</SelectOption>}
              {pages.map((p) => (
                <SelectOption key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </SelectOption>
              ))}
              <SelectOption value={OTHER}>Outra (digitar o ID)</SelectOption>
            </Select>
          )}
        </label>
        {page === OTHER && (
          <label>
            ID da página do Facebook
            <Input
              inputMode="numeric"
              value={typedPage}
              onChange={(e) => setTypedPage(e.target.value.replace(/\s/g, ""))}
              placeholder="Ex.: 104455667788"
            />
          </label>
        )}
        <label>
          Formulário do Facebook
          {pageId && forms === null ? (
            <Loading compact />
          ) : (
            <Select
              value={form}
              onValueChange={setForm}
              disabled={!forms?.length}
              aria-label="Formulário do Facebook"
            >
              <SelectOption value="">
                {forms && !forms.length
                  ? "Nenhum formulário nesta página"
                  : "Selecione"}
              </SelectOption>
              {(forms ?? []).map((f) => (
                <SelectOption key={f.id} value={f.id}>
                  {f.name} · {f.status}
                  {f.leads !== null ? ` · ${f.leads} cadastros` : ""}
                  {pageName ? ` (Página: ${pageName})` : ""}
                </SelectOption>
              ))}
            </Select>
          )}
        </label>
        <div className="form-columns">
          <label>
            Página de captura da Make
            <Select
              value={landing}
              onValueChange={setLanding}
              aria-label="Página de captura da Make"
            >
              {landingPages.map((id) => (
                <SelectOption key={id} value={id}>
                  {id} (deste ciclo)
                </SelectOption>
              ))}
              <SelectOption value={OTHER}>Outra (digitar o ID)</SelectOption>
            </Select>
          </label>
          <label>
            ID do cliente na Make
            <Input
              inputMode="numeric"
              value={makeUser}
              onChange={(e) => setMakeUser(e.target.value.replace(/\D/g, ""))}
              placeholder="O id do cliente no MASO"
            />
          </label>
        </div>
        {landing === OTHER && (
          <label>
            ID da página de captura
            <Input
              value={typedLanding}
              onChange={(e) => setTypedLanding(e.target.value.trim())}
              placeholder="O id da página de captura (id_squeeze)"
            />
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={busy}
          >
            Fechar
          </Button>
          <Button
            type="button"
            className="btn primary"
            loading={busy}
            disabled={!form || !landingId || !makeUser.trim()}
            onClick={() => void save()}
          >
            Integrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
