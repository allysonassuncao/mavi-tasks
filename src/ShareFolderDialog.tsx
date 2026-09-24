import { useEffect, useMemo, useState } from "react";
import { Copy, Globe, Lock, Search, Users } from "lucide-react";
import { Avatar, Modal } from "./components";
import { Button, Checkbox, Input, Loading } from "./ui";
import { fold } from "./domain";
import { folderSharing, publicFolderUrl, setFolderSharing } from "./drive";
import type { DriveFolder, DriveFolderSharing, Snapshot } from "./types";

/**
 * Shares a Drive folder (inside a product) two ways: a public, read-only
 * link, and chosen people of the company who then see it (and everything
 * inside) even without access to the client.
 */
export function ShareFolderDialog({
  folder,
  data,
  user,
  onClose,
  onSaved,
  notify,
}: {
  folder: DriveFolder;
  data: Snapshot;
  user: string;
  onClose: () => void;
  onSaved: (sharing: DriveFolderSharing) => void;
  notify: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<DriveFolderSharing | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    folderSharing(folder.id)
      .then((s) => {
        setLoaded(s);
        setIsPublic(s.visibility === "public");
        setMembers(s.members);
      })
      .catch((e) => setError((e as Error).message));
  }, [folder.id]);

  // Leaders already see every folder; the one sharing needs no invitation.
  const candidates = useMemo(
    () =>
      data.members
        .filter(
          (m) =>
            m.active &&
            m.user_id !== user &&
            m.role !== "admin" &&
            m.role !== "manager",
        )
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.members, user],
  );
  const shown = candidates.filter((m) =>
    fold(`${m.name} ${m.email ?? ""}`).includes(fold(query.trim())),
  );
  const toggle = (id: string) =>
    setMembers((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );
  // The link is issued when saving with it on (and replaced when turned off).
  const link =
    loaded && isPublic && loaded.visibility === "public"
      ? publicFolderUrl(loaded.share_token)
      : "";

  async function save() {
    setBusy(true);
    setError("");
    try {
      const saved = await setFolderSharing(folder.id, isPublic, members);
      setLoaded(saved);
      onSaved(saved);
      if (saved.visibility === "public" && loaded?.visibility !== "public") {
        const url = publicFolderUrl(saved.share_token);
        await navigator.clipboard.writeText(url).catch(() => {});
        notify("Compartilhamento salvo. Link público copiado.");
      } else notify("Compartilhamento salvo.");
      if (saved.visibility !== "public" || loaded?.visibility === "public")
        onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Compartilhar “${folder.name}”`}
      onClose={onClose}
      busy={busy}
    >
      <div className="entity-form share-folder">
        {!loaded && !error ? (
          <Loading compact />
        ) : (
          <>
            <section className="share-block">
              <label className="share-toggle">
                <Checkbox
                  checked={isPublic}
                  onCheckedChange={(v) => setIsPublic(v === true)}
                  disabled={!loaded}
                />
                <span>
                  <strong>
                    <Globe size={15} /> Link público
                  </strong>
                  <small>
                    Qualquer pessoa com o link vê e baixa os arquivos desta
                    pasta e das subpastas, sem entrar no sistema. Ninguém envia
                    nem altera nada.
                  </small>
                </span>
              </label>
              {isPublic && (
                <p className="share-warning" role="note">
                  <Lock size={14} /> Arquivos marcados como privados dentro da
                  pasta também ficam acessíveis por este link.
                </p>
              )}
              {link && (
                <div className="share-link">
                  <Input readOnly value={link} aria-label="Link público" />
                  <Button
                    className="btn secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(link)
                        .then(() => notify("Link copiado."))
                        .catch(() => setError(`Copie o link: ${link}`))
                    }
                  >
                    <Copy size={15} /> Copiar
                  </Button>
                </div>
              )}
              {loaded?.visibility === "public" && !isPublic && (
                <small className="share-hint">
                  Ao salvar, o link atual deixa de funcionar para sempre.
                </small>
              )}
            </section>

            <section className="share-block">
              <strong className="share-title">
                <Users size={15} /> Pessoas com acesso
              </strong>
              <small>
                Quem você escolher vê esta pasta, as subpastas e os arquivos
                (sem poder enviar ou alterar), mesmo sem ser da equipe do
                cliente. Administradores e gestores já veem todas as pastas.
              </small>
              <span className="share-search">
                <Input
                  type="search"
                  icon={Search}
                  placeholder="Buscar pessoa"
                  aria-label="Buscar pessoa"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </span>
              <ul className="share-people" aria-label="Pessoas do espaço">
                {shown.map((m) => (
                  <li key={m.user_id}>
                    <label>
                      <Checkbox
                        checked={members.includes(m.user_id)}
                        onCheckedChange={() => toggle(m.user_id)}
                      />
                      <Avatar name={m.name} src={m.avatar_url} size="small" />
                      <span>
                        <strong>{m.name}</strong>
                        {m.email && <small>{m.email}</small>}
                      </span>
                    </label>
                  </li>
                ))}
                {!shown.length && (
                  <li className="share-empty">
                    {candidates.length
                      ? "Ninguém encontrado."
                      : "Não há colaboradores para convidar."}
                  </li>
                )}
              </ul>
              {members.length > 0 && (
                <small className="share-hint">
                  {members.length === 1
                    ? "1 pessoa selecionada"
                    : `${members.length} pessoas selecionadas`}
                </small>
              )}
            </section>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            className="btn primary"
            onClick={() => void save()}
            loading={busy}
            disabled={!loaded}
          >
            Salvar compartilhamento
          </Button>
        </div>
      </div>
    </Modal>
  );
}
