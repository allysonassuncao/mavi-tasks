import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Camera,
  Check,
  KeyRound,
  Mail,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import { Avatar } from "./components";
import { ConnectedApps } from "./ConnectedApps";
import { Button, Input } from "./ui";
import type { Snapshot } from "./types";
import { formatBytes } from "./drive";
import {
  changePassword,
  optimizeAvatar,
  uploadAvatar,
  type OptimizedAvatar,
} from "./profile";
import {
  loadMemberPhone,
  phoneDigits,
  phoneLabel,
  saveMemberPhone,
} from "./temperature";

const roleLabel = {
  admin: "Administrador",
  manager: "Gestor",
  member: "Colaborador",
};

/** "Meu perfil": the signed-in person edits their own name, photo and password. */
export function ProfilePage({
  company,
  data,
  user,
  email,
  demo,
  mutate,
  notify,
}: {
  company: string;
  data: Snapshot;
  user: string;
  email: string;
  demo: boolean;
  mutate: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  notify: (message: string) => void;
}) {
  const me = data.members.find((m) => m.user_id === user);
  const [name, setName] = useState(me?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  // O celular: nos grupos de WhatsApp dos clientes, as mensagens dele são do time.
  const [phone, setPhone] = useState("");
  const [savedPhone, setSavedPhone] = useState<string | null>(null);
  useEffect(() => {
    if (!company) return;
    loadMemberPhone(company, user)
      .then((p) => {
        setSavedPhone(p);
        setPhone(phoneLabel(p));
      })
      .catch(() => {});
  }, [company, user]);
  const phoneChanged = phoneDigits(phone) !== (savedPhone ?? "");
  const nameChanged = name.trim() !== me?.name;
  const [photo, setPhoto] = useState<OptimizedAvatar | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (me?.name) setName(me.name);
  }, [me?.name]);
  useEffect(
    () => () => {
      // In the demo the preview URL becomes the saved photo; keep it alive.
      if (photo && !demo) URL.revokeObjectURL(photo.preview);
    },
    [photo, demo],
  );
  const teams = data.teamMembers
    .filter((tm) => tm.user_id === user)
    .map((tm) => ({
      name: data.teams.find((t) => t.id === tm.team_id)?.name,
      supervisor: tm.supervisor,
    }))
    .filter((t) => t.name);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSavingName(true);
    try {
      if (nameChanged) await mutate("update_my_profile", { p_name: name.trim() });
      if (phoneChanged) {
        const saved = await saveMemberPhone(company, user, phone);
        setSavedPhone(saved);
        setPhone(phoneLabel(saved));
      }
      notify(
        nameChanged && phoneChanged
          ? "Nome e celular atualizados."
          : nameChanged
            ? "Nome atualizado."
            : "Celular atualizado.",
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingName(false);
    }
  }
  async function choosePhoto(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      setPhoto(await optimizeAvatar(file));
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function savePhoto() {
    if (!photo) return;
    setError("");
    setSavingPhoto(true);
    try {
      // The demo has no storage: it keeps the optimized image in memory.
      const url = demo ? photo.preview : await uploadAvatar(photo);
      // The size is recorded for the Armazenamento page. Databases still
      // without migration 20260930100000 only know p_url.
      await mutate("set_my_avatar", {
        p_url: url,
        p_size: photo.blob.size,
      }).catch((e: Error) => {
        if (!/could not find the function/i.test(e.message)) throw e;
        return mutate("set_my_avatar", { p_url: url });
      });
      setPhoto(null);
      notify("Foto de perfil atualizada.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingPhoto(false);
    }
  }
  async function removePhoto() {
    setError("");
    setSavingPhoto(true);
    try {
      await mutate("set_my_avatar", { p_url: null });
      notify("Foto de perfil removida.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingPhoto(false);
    }
  }
  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8)
      return setError("A nova senha deve ter no mínimo 8 caracteres.");
    if (password !== confirm)
      return setError("A confirmação não confere com a nova senha.");
    setSavingPassword(true);
    try {
      await changePassword(password);
      setPassword("");
      setConfirm("");
      notify("Senha alterada.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="profile-page">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {/* Who you are, across the page: photo, name, access and teams. */}
      <section className="panel profile-hero">
        <div className="profile-photo">
          {photo ? (
            <span className="avatar xlarge">
              <img src={photo.preview} alt="Prévia da nova foto" />
            </span>
          ) : (
            <Avatar
              name={me?.name ?? "Usuário"}
              src={me?.avatar_url}
              size="xlarge"
            />
          )}
          <div className="profile-identity">
            <h2>{me?.name ?? "Usuário"}</h2>
            <ul className="profile-facts">
              <li>
                <Mail size={14} aria-hidden="true" /> {email || "—"}
              </li>
              {me && (
                <li>
                  <ShieldCheck size={14} aria-hidden="true" />{" "}
                  {roleLabel[me.role]}
                </li>
              )}
              <li>
                <UsersRound size={14} aria-hidden="true" />
                {teams.length ? (
                  <span className="profile-teams">
                    {teams.map((t) => (
                      <span key={t.name} className="profile-team">
                        {t.name}
                        {t.supervisor && <em> · supervisor</em>}
                      </span>
                    ))}
                  </span>
                ) : (
                  "Sem equipe"
                )}
              </li>
            </ul>
          </div>
          <div className="profile-photo-actions">
            {photo ? (
              <>
                <p className="profile-photo-note">
                  Otimizada para {formatBytes(photo.blob.size)} (original{" "}
                  {formatBytes(photo.originalBytes)}).
                </p>
                <div>
                  <Button
                    className="btn primary"
                    loading={savingPhoto}
                    onClick={() => void savePhoto()}
                  >
                    <Check size={16} /> Salvar foto
                  </Button>
                  <Button
                    className="btn secondary"
                    disabled={savingPhoto}
                    onClick={() => setPhoto(null)}
                  >
                    Cancelar
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="profile-photo-note">
                  JPG, PNG ou WebP. A imagem é recortada em quadrado e reduzida
                  automaticamente para ficar leve.
                </p>
                <div>
                  <Button
                    className="btn secondary"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Camera size={16} />{" "}
                    {me?.avatar_url ? "Trocar foto" : "Enviar foto"}
                  </Button>
                  {me?.avatar_url && (
                    <Button
                      className="btn secondary"
                      disabled={savingPhoto}
                      onClick={() => void removePhoto()}
                    >
                      <Trash2 size={16} /> Remover
                    </Button>
                  )}
                </div>
              </>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              hidden
              onChange={(e) => {
                void choosePhoto(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>
      </section>

      <div className="profile-grid">
        <section className="panel profile-card">
          <div className="panel-heading">
            <div>
              <h2>
                <UserRound size={18} /> Informações básicas
              </h2>
              <p>Seu nome aparece para todas as pessoas do espaço.</p>
            </div>
          </div>
          <form className="entity-form profile-form" onSubmit={saveName}>
            <label>
              Nome
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
                maxLength={120}
                autoComplete="name"
              />
            </label>
            <label>
              Celular com WhatsApp
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(11) 98765-4321"
                autoComplete="tel"
                maxLength={24}
              />
            </label>
            <small>
              Nos grupos de WhatsApp dos clientes, as mensagens deste número
              contam como do time: o termômetro do cliente avalia só o cliente.
            </small>
            <div className="form-columns">
              <label>
                E-mail
                <Input type="email" value={email} readOnly disabled />
              </label>
              <label>
                Perfil de acesso
                <Input value={me ? roleLabel[me.role] : ""} readOnly disabled />
              </label>
            </div>
            <small>
              Para trocar o e-mail ou o perfil de acesso, fale com um
              administrador.
            </small>
            <div className="form-footer">
              <Button
                className="btn primary"
                loading={savingName}
                disabled={(!nameChanged && !phoneChanged) || name.trim().length < 2}
              >
                <Check size={16} /> Salvar
              </Button>
            </div>
          </form>
        </section>

        {!demo && (
          <section className="panel profile-card">
            <div className="panel-heading">
              <div>
                <h2>
                  <KeyRound size={18} /> Senha
                </h2>
                <p>Use pelo menos 8 caracteres.</p>
              </div>
            </div>
            <form className="entity-form profile-form" onSubmit={savePassword}>
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={email}
                readOnly
                hidden
              />
              <div className="form-columns">
                <label>
                  Nova senha
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </label>
                <label>
                  Confirmar nova senha
                  <Input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </label>
              </div>
              <div className="form-footer">
                <Button className="btn primary" loading={savingPassword}>
                  <Check size={16} /> Alterar senha
                </Button>
              </div>
            </form>
          </section>
        )}
      </div>
      {!demo && <ConnectedApps notify={notify} />}
    </div>
  );
}
