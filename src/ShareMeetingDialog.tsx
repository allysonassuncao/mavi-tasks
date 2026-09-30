import { useEffect, useState } from "react";
import { Copy, Eye, Globe, KeyRound, Link2, Lock, Trash2 } from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { DateInput } from "./DateInput";
import {
  clock,
  deleteMeetingShare,
  meetingShare,
  publicRecordingUrl,
  saveMeetingShare,
  type MeetingShare,
} from "./meetings";

type Validity = "keep" | "never" | "1d" | "7d" | "30d" | "90d" | "custom";
const DAYS: Partial<Record<Validity, number>> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
/** "aaaa-mm-ddThh:mm" no fuso do navegador, para o campo de data e hora. */
const localInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);

/**
 * O link público de uma gravação: quem abre não precisa entrar no sistema e
 * vê só o que foi escolhido aqui (vídeo, transcrição, resumo), baixa se o
 * download estiver liberado, até a validade, com senha se tiver. Os
 * próximos passos e a MAVI nunca vão para o link.
 */
export function ShareMeetingDialog({
  recording,
  title,
  hasVideo,
  time,
  onClose,
  onChange,
  notify,
}: {
  recording: string;
  title: string;
  /** A gravação tem vídeo guardado. */
  hasVideo: boolean;
  /** O momento em que o player está (para o link abrir nele). */
  time: number;
  onClose: () => void;
  /** O link foi criado, alterado ou desativado. */
  onChange?: () => void;
  notify: (message: string) => void;
}) {
  const [share, setShare] = useState<MeetingShare | null | undefined>(
    undefined,
  );
  const [video, setVideo] = useState(hasVideo);
  const [transcript, setTranscript] = useState(true);
  const [summary, setSummary] = useState(true);
  const [download, setDownload] = useState(false);
  const [validity, setValidity] = useState<Validity>("never");
  const [custom, setCustom] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [changePassword, setChangePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [atMoment, setAtMoment] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function fill(s: MeetingShare | null) {
    setShare(s);
    if (!s) return;
    setVideo(hasVideo && s.show_video);
    setTranscript(s.show_transcript);
    setSummary(s.show_summary);
    setDownload(s.allow_download);
    setValidity(s.expires_at ? (s.expired ? "7d" : "keep") : "never");
    setUsePassword(s.has_password);
    setChangePassword(false);
    setPassword("");
  }
  useEffect(() => {
    meetingShare(recording)
      .then(fill)
      .catch((e) => {
        setShare(null);
        setError((e as Error).message);
      });
    // Só ao abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const readOnly = !!share && !share.can_manage;
  const link = share
    ? publicRecordingUrl(share.token, atMoment ? time : undefined)
    : "";
  const shows = (hasVideo && video) || transcript || summary;
  const askPassword = usePassword && (!share?.has_password || changePassword);

  function expiresAt(): string | null {
    if (validity === "keep") return share?.expires_at ?? null;
    if (validity === "never") return null;
    if (validity === "custom") {
      if (!custom) throw Error("Escolha a data e a hora em que o link vence.");
      const d = new Date(custom);
      if (Number.isNaN(d.getTime())) throw Error("Data de validade inválida.");
      return d.toISOString();
    }
    return new Date(Date.now() + DAYS[validity]! * 86400000).toISOString();
  }

  async function copy(url = link) {
    try {
      await navigator.clipboard.writeText(url);
      notify(
        atMoment
          ? `Link público copiado: abre a gravação em ${clock(time)}.`
          : "Link público copiado.",
      );
    } catch {
      setError(`Copie o link: ${url}`);
    }
  }

  async function save() {
    setError("");
    if (!shows) {
      setError("Escolha o que o link mostra: vídeo, transcrição ou resumo.");
      return;
    }
    if (askPassword && password.length < 4) {
      setError("A senha precisa ter pelo menos 4 caracteres.");
      return;
    }
    setBusy(true);
    try {
      const created = !share;
      const saved = await saveMeetingShare(recording, {
        video: hasVideo && video,
        transcript,
        summary,
        download,
        expiresAt: expiresAt(),
        password: !usePassword ? "" : askPassword ? password : undefined,
      });
      fill(saved);
      onChange?.();
      if (created) {
        const url = publicRecordingUrl(
          saved.token,
          atMoment ? time : undefined,
        );
        await navigator.clipboard.writeText(url).catch(() => {});
        notify("Link público criado e copiado.");
      } else notify("Link público atualizado.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError("");
    try {
      await deleteMeetingShare(recording);
      onChange?.();
      notify("Link público desativado. O endereço antigo não abre mais.");
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Link público da gravação" onClose={onClose} busy={busy}>
      <div className="entity-form share-folder share-meeting">
        {share === undefined ? (
          <Loading variant="form" />
        ) : (
          <>
            <p className="share-meeting-intro">
              <Globe size={15} aria-hidden="true" />
              <span>
                Qualquer pessoa com o link abre <strong>{title}</strong> sem
                entrar no sistema e vê só o que você escolher abaixo. Os
                próximos passos e a MAVI não aparecem no link.
              </span>
            </p>

            {share && (
              <section className="share-block">
                {share.expired && (
                  <p className="share-warning" role="note">
                    <Lock size={14} /> Este link venceu em{" "}
                    {dateTime(share.expires_at!)} e não abre mais. Escolha uma
                    nova validade para reativá-lo com o mesmo endereço.
                  </p>
                )}
                <div className="share-link">
                  <Input readOnly value={link} aria-label="Link público" />
                  <Button
                    type="button"
                    className="btn secondary"
                    onClick={() => void copy()}
                  >
                    <Copy size={15} /> Copiar
                  </Button>
                </div>
                {time >= 1 && (
                  <label className="share-toggle share-inline">
                    <Checkbox
                      checked={atMoment}
                      onCheckedChange={(v) => setAtMoment(v === true)}
                    />
                    <span>
                      <Link2 size={14} aria-hidden="true" /> Abrir o vídeo em{" "}
                      {clock(time)}
                    </span>
                  </label>
                )}
                <small className="share-hint share-meeting-stats">
                  <Eye size={13} aria-hidden="true" />
                  {share.opens
                    ? `Aberto ${share.opens === 1 ? "1 vez" : `${share.opens} vezes`}, a última em ${dateTime(share.last_opened_at!)}`
                    : "Ainda não foi aberto"}
                  {share.allow_download || share.downloads
                    ? ` · ${share.downloads === 1 ? "1 download" : `${share.downloads} downloads`} do vídeo`
                    : ""}
                </small>
              </section>
            )}

            <fieldset className="share-block" disabled={readOnly}>
              <strong className="share-title">O que o link mostra</strong>
              <div className="share-meeting-options">
                <label className="share-toggle">
                  <Checkbox
                    checked={hasVideo && video}
                    disabled={!hasVideo || readOnly}
                    onCheckedChange={(v) => setVideo(v === true)}
                  />
                  <span>
                    <strong>Vídeo</strong>
                    <small>
                      {hasVideo
                        ? "O player da reunião."
                        : "Esta reunião não tem vídeo guardado."}
                    </small>
                  </span>
                </label>
                <label className="share-toggle">
                  <Checkbox
                    checked={transcript}
                    disabled={readOnly}
                    onCheckedChange={(v) => setTranscript(v === true)}
                  />
                  <span>
                    <strong>Transcrição</strong>
                    <small>Com busca e o tempo de cada fala.</small>
                  </span>
                </label>
                <label className="share-toggle">
                  <Checkbox
                    checked={summary}
                    disabled={readOnly}
                    onCheckedChange={(v) => setSummary(v === true)}
                  />
                  <span>
                    <strong>Resumo</strong>
                    <small>Visão geral, assuntos, temas e participantes.</small>
                  </span>
                </label>
              </div>
              <label className="share-toggle">
                <Checkbox
                  checked={download}
                  disabled={readOnly}
                  onCheckedChange={(v) => setDownload(v === true)}
                />
                <span>
                  <strong>Permitir download</strong>
                  <small>
                    Quem abre o link baixa o vídeo e a transcrição e o resumo em
                    texto (só o que o link mostra).
                  </small>
                </span>
              </label>
            </fieldset>

            <fieldset className="share-block" disabled={readOnly}>
              <strong className="share-title">Validade</strong>
              <div className="share-meeting-validity">
                <Select
                  aria-label="Validade do link"
                  value={validity}
                  disabled={readOnly}
                  onValueChange={(v) => {
                    setValidity(v as Validity);
                    if (v === "custom" && !custom)
                      setCustom(
                        localInput(new Date(Date.now() + 7 * 86400000)),
                      );
                  }}
                >
                  {share?.expires_at && !share.expired && (
                    <SelectOption value="keep">
                      {`Até ${dateTime(share.expires_at)}`}
                    </SelectOption>
                  )}
                  <SelectOption value="never">Sem validade</SelectOption>
                  <SelectOption value="1d">24 horas</SelectOption>
                  <SelectOption value="7d">7 dias</SelectOption>
                  <SelectOption value="30d">30 dias</SelectOption>
                  <SelectOption value="90d">90 dias</SelectOption>
                  <SelectOption value="custom">
                    Escolher data e hora
                  </SelectOption>
                </Select>
                {validity === "custom" && (
                  <DateInput
                    type="datetime-local"
                    aria-label="Link vale até"
                    value={custom}
                    min={localInput(new Date())}
                    onChange={(e) => setCustom(e.target.value)}
                    disabled={readOnly}
                  />
                )}
              </div>
              <small className="share-hint">
                {validity === "never"
                  ? "O link vale até ser desativado."
                  : validity === "keep" || validity === "custom"
                    ? "Depois disso o link não abre mais; você pode estender a validade."
                    : "Contado a partir de agora, ao salvar."}
              </small>
            </fieldset>

            <fieldset className="share-block" disabled={readOnly}>
              <label className="share-toggle">
                <Checkbox
                  checked={usePassword}
                  disabled={readOnly}
                  onCheckedChange={(v) => {
                    setUsePassword(v === true);
                    setPassword("");
                  }}
                />
                <span>
                  <strong>
                    <KeyRound size={15} /> Pedir senha
                  </strong>
                  <small>
                    Envie a senha separada do link. Dez tentativas erradas
                    bloqueiam o link por 15 minutos.
                  </small>
                </span>
              </label>
              {usePassword && share?.has_password && !changePassword ? (
                <small className="share-hint">
                  Este link já tem senha.{" "}
                  {!readOnly && (
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => setChangePassword(true)}
                    >
                      Trocar senha
                    </button>
                  )}
                </small>
              ) : askPassword ? (
                <Input
                  type="password"
                  autoComplete="new-password"
                  aria-label="Senha do link"
                  placeholder="Pelo menos 4 caracteres"
                  value={password}
                  maxLength={72}
                  onChange={(e) => setPassword(e.target.value)}
                />
              ) : null}
            </fieldset>

            {readOnly && (
              <small className="share-hint">
                Só quem criou o link ou um líder altera as opções ou desativa o
                link.
              </small>
            )}
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          {share?.can_manage &&
            (confirmOff ? (
              <Button
                type="button"
                className="btn danger"
                onClick={() => void turnOff()}
                loading={busy}
              >
                <Trash2 size={15} /> Confirmar: desativar para sempre
              </Button>
            ) : (
              <Button
                type="button"
                className="btn secondary share-meeting-off"
                onClick={() => setConfirmOff(true)}
                disabled={busy}
              >
                <Trash2 size={15} /> Desativar link
              </Button>
            ))}
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={busy}
          >
            {readOnly ? "Fechar" : "Cancelar"}
          </Button>
          {!readOnly && share !== undefined && (
            <Button
              type="button"
              className="btn primary"
              onClick={() => void save()}
              loading={busy && !confirmOff}
            >
              {share ? "Salvar alterações" : "Criar link público"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
