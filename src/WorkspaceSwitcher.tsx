import { useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronsUpDown, ImageUp, Search, Trash2 } from "lucide-react";
import { Button } from "./ui";
import { Modal } from "./components";
import { fold, initials } from "./domain";
import {
  optimizeLogo,
  uploadCompanyLogo,
  type OptimizedAvatar,
} from "./profile";
import type { Company } from "./types";

/** The company's image, or its initials when it has none. */
export function CompanyLogo({
  company,
  size = "normal",
}: {
  company?: Pick<Company, "name" | "logo_url">;
  size?: "normal" | "large";
}) {
  return (
    <span
      className={`company-logo ${size}`}
      aria-hidden="true"
      title={company?.name}
    >
      {company?.logo_url ? (
        <img src={company.logo_url} alt="" decoding="async" />
      ) : (
        initials(company?.name ?? "?")
      )}
    </span>
  );
}

/** Beyond this many companies the menu gets a search field. */
const SEARCH_FROM = 7;

/**
 * The workspace in the sidebar: the company's logo and name. With several
 * companies it opens a menu to switch (searchable when long); for
 * administrators it also changes the logo. With nothing to choose it is a
 * plain label.
 */
export function WorkspaceSwitcher({
  companies,
  current,
  isAdmin,
  collapsed,
  onSelect,
  onChangeLogo,
}: {
  companies: Company[];
  current?: Company;
  isAdmin: boolean;
  /** The sidebar is narrow: the menu opens to its right. */
  collapsed: boolean;
  onSelect: (id: string) => void;
  onChangeLogo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const many = companies.length > 1;
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return [...companies]
      .filter((c) => fold(c.name).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [companies, query]);
  const label = (
    <>
      <CompanyLogo company={current} />
      <span className="workspace-name">
        {current?.name ?? "Espaço de trabalho"}
      </span>
    </>
  );
  if (!many && !isAdmin)
    return (
      <div className="workspace-switch static" title={current?.name}>
        {label}
      </div>
    );
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="workspace-switch"
          aria-label={`Espaço de trabalho: ${current?.name ?? ""}`}
          title={current?.name}
        >
          {label}
          <ChevronsUpDown
            size={14}
            className="workspace-chevron"
            aria-hidden="true"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={`workspace-menu ${collapsed ? "beside" : ""}`}
          side={collapsed ? "right" : "bottom"}
          align="start"
          sideOffset={collapsed ? 12 : 6}
          collisionPadding={12}
        >
          {many && (
            <>
              <span className="workspace-menu-title">Espaços de trabalho</span>
              {companies.length >= SEARCH_FROM && (
                <label className="workspace-menu-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    aria-label="Buscar espaço de trabalho"
                    placeholder="Buscar"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                  />
                </label>
              )}
              <div className="workspace-menu-list" role="listbox">
                {shown.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={c.id === current?.id}
                    className={c.id === current?.id ? "current" : ""}
                    onClick={() => {
                      setOpen(false);
                      if (c.id !== current?.id) onSelect(c.id);
                    }}
                  >
                    <CompanyLogo company={c} />
                    <span>{c.name}</span>
                    {c.id === current?.id && (
                      <Check size={15} aria-hidden="true" />
                    )}
                  </button>
                ))}
                {!shown.length && (
                  <small className="workspace-menu-empty">
                    Nada encontrado.
                  </small>
                )}
              </div>
            </>
          )}
          {isAdmin && (
            <>
              {many && <hr />}
              <button
                type="button"
                className="workspace-menu-action"
                onClick={() => {
                  setOpen(false);
                  onChangeLogo();
                }}
              >
                <ImageUp size={15} aria-hidden="true" />
                {current?.logo_url
                  ? "Trocar logo da empresa"
                  : "Adicionar logo da empresa"}
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Administrators pick, preview and save (or remove) the company logo. */
export function CompanyLogoDialog({
  company,
  demo,
  mutate,
  onClose,
}: {
  company: Company;
  demo: boolean;
  mutate: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}) {
  const [image, setImage] = useState<OptimizedAvatar | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function choose(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      setImage(await optimizeLogo(file));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save(url: string | null, size?: number) {
    setBusy(true);
    setError("");
    try {
      await mutate("set_company_logo", {
        p_company: company.id,
        p_url: url,
        p_size: size ?? null,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const preview = image?.preview ?? company.logo_url;
  return (
    <Modal
      title="Logo da empresa"
      onClose={() => !busy && onClose()}
      busy={busy}
    >
      <div className="entity-form company-logo-form">
        <div className="company-logo-preview">
          <CompanyLogo
            company={{ name: company.name, logo_url: preview }}
            size="large"
          />
          <p>
            Aparece no menu lateral para todas as pessoas de{" "}
            <strong>{company.name}</strong>. Use uma imagem quadrada ou o
            símbolo da marca; ela é ajustada para 256 × 256 sem cortar.
          </p>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            void choose(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="company-logo-actions">
          {company.logo_url && !image && (
            <Button
              className="text-btn danger"
              disabled={busy}
              onClick={() => void save(null)}
            >
              <Trash2 size={14} /> Remover logo
            </Button>
          )}
          <Button
            className="btn secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <ImageUp size={15} />{" "}
            {image || company.logo_url
              ? "Escolher outra imagem"
              : "Escolher imagem"}
          </Button>
          <Button
            className="btn primary"
            disabled={!image}
            loading={busy}
            onClick={async () => {
              if (!image) return;
              setBusy(true);
              try {
                // The demo stores nothing: it keeps the image in memory.
                const url = demo
                  ? image.preview
                  : await uploadCompanyLogo(company.id, image);
                await save(url, image.blob.size);
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Salvar logo
          </Button>
        </div>
      </div>
    </Modal>
  );
}
