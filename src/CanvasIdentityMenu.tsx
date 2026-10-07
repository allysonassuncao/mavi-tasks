import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, Loader2, Palette, Sparkles } from "lucide-react";
import { listIdentities } from "./identities";
import { IMAGE_FILE, loadBrand } from "./brand";
import { BUILTIN_LOOKS, builtinLook, sanitizeTokens, tokensFromBrand, type IdentityRow, type Look } from "./visual-identity";

/**
 * MAVI · "Aplicar identidade" no canvas: a do cliente da conversa (ou a Marca
 * dele), a da empresa, a galeria e os estilos prontos. Escolher salva uma
 * versão nova com o tema na hora, sem pedir à MAVI.
 */

export type LookGroup = { title: string; looks: Look[] };

const asLook = (r: IdentityRow, source: Look["source"]): Look => ({
  ...sanitizeTokens(r.tokens),
  id: r.id,
  name: r.name,
  source,
  ...(r.client_id ? { client: r.client_id } : {}),
});

export async function loadLooks(company: string, client: string | null): Promise<LookGroup[]> {
  const list = await listIdentities(company, client);
  const groups: LookGroup[] = [];
  if (client) {
    if (list.client) groups.push({ title: "Do cliente", looks: [asLook(list.client, "client")] });
    else {
      // Sem identidade salva, a Marca do Drive vira o tema (como a MAVI faz).
      const b = await loadBrand(company, client).catch(() => null);
      if (b && (b.colors.length > 0 || b.fonts.length > 0 || b.files.some((f) => IMAGE_FILE.test(f.name))))
        groups.push({
          title: "Do cliente",
          looks: [{ ...tokensFromBrand(b), id: `brand:${client}`, name: `Marca de ${b.client_name}`, source: "client", client }],
        });
    }
  }
  if (list.company) groups.push({ title: "Da empresa", looks: [asLook(list.company, "company")] });
  if (list.gallery.length) groups.push({ title: "Galeria", looks: list.gallery.map((r) => asLook(r, "gallery")) });
  groups.push({ title: "Estilos prontos", looks: Object.keys(BUILTIN_LOOKS).map((k) => builtinLook(k)!) });
  return groups;
}

export function IdentityMenu({
  company,
  client,
  current,
  design,
  disabled,
  onApply,
  onAsk,
  load = loadLooks,
}: {
  company: string;
  /** O cliente da conversa (ou o da identidade atual). */
  client: string | null;
  current: Look | null;
  /** Design livre: troca o tema e as cores e fontes do desenho. */
  design: boolean;
  disabled?: boolean;
  onApply: (look: Look) => Promise<void>;
  /** Pedir à MAVI (outra identidade descrita, ou refazer o desenho). */
  onAsk: () => void;
  load?: typeof loadLooks;
}) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<LookGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [applying, setApplying] = useState("");
  function toggle(next: boolean) {
    setOpen(next);
    if (!next) return;
    setFailed(false);
    load(company, client)
      .then(setGroups)
      .catch(() => {
        setFailed(true);
        setGroups([{ title: "Estilos prontos", looks: Object.keys(BUILTIN_LOOKS).map((k) => builtinLook(k)!) }]);
      });
  }
  async function pick(look: Look) {
    setApplying(look.id);
    try {
      await onApply(look);
      setOpen(false);
    } finally {
      setApplying("");
    }
  }
  return (
    <Popover.Root open={open} onOpenChange={toggle}>
      <Popover.Trigger asChild>
        <button type="button" className="btn secondary canvas-edit-btn" disabled={disabled} title="Aplicar uma identidade visual salva (vira uma versão nova)">
          <Palette size={15} /> <span className="canvas-btn-label">Aplicar identidade</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="status-menu canvas-menu canvas-identity-menu" align="end" sideOffset={6} collisionPadding={12}>
          <p className="cedit-pop-title">Aplicar identidade</p>
          {design && (
            <p className="canvas-identity-hint">
              No design livre, trocam o tema e as cores, fontes e o logo que o desenho usa. Para mudar o desenho, peça à MAVI.
            </p>
          )}
          {failed && <p className="canvas-identity-hint">Não deu para carregar as identidades salvas agora.</p>}
          {!groups ? (
            <p className="canvas-identity-loading">
              <Loader2 size={14} className="spin" /> Carregando…
            </p>
          ) : (
            <div className="canvas-identity-list">
              {groups.map((g) => (
                <section key={g.title} aria-label={g.title}>
                  <h4>{g.title}</h4>
                  {g.looks.map((l) => {
                    const on = current?.id === l.id;
                    return (
                      <button
                        key={l.id}
                        type="button"
                        className={on ? "on" : undefined}
                        disabled={!!applying || on}
                        aria-current={on || undefined}
                        title={on ? "É a identidade deste arquivo" : `${l.heading.family} · ${l.body.family}`}
                        onClick={() => void pick(l)}
                      >
                        <span className="canvas-look-swatch" aria-hidden="true">
                          <i style={{ background: l.colors.bg }} />
                          <i style={{ background: l.colors.primary }} />
                          <i style={{ background: l.colors.accent }} />
                        </span>
                        <span className="canvas-identity-name">{l.name}</span>
                        {applying === l.id ? <Loader2 size={14} className="spin" /> : on ? <Check size={14} /> : null}
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
          <button
            type="button"
            className="canvas-identity-ask"
            onClick={() => {
              setOpen(false);
              onAsk();
            }}
          >
            <Sparkles size={14} /> {design ? "Pedir à MAVI para refazer o desenho" : "Pedir à MAVI outra identidade"}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
