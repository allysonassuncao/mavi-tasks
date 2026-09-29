import { BellRing } from "lucide-react";
import { useState } from "react";
import * as api from "./api";
import {
  enableNotifications,
  type NotificationState,
} from "./notifications";
import {
  isPaused,
  NOTICE_TYPES,
  pauseLabel,
  STATUS_ROLES,
  STATUS_ROWS,
  statusKey,
  type NotificationPrefs,
  type PauseChoice,
} from "./notificationPrefs";
import { Button, Checkbox, Skeleton } from "./ui";

/**
 * Meu perfil › Notificações: what the person receives, on every device.
 * Each change saves on its own; a type turned off doesn't arrive at all
 * (neither the inbox nor the browser), the pause holds only the browser.
 */
export function NotificationSettings({
  company,
  demo,
  prefs,
  onPrefs,
  onPause,
  state,
  onState,
  notify,
}: {
  company: string;
  demo: boolean;
  prefs: NotificationPrefs | null;
  onPrefs: (prefs: NotificationPrefs) => void;
  onPause: (choice: PauseChoice | null) => Promise<void>;
  state: NotificationState;
  onState: (state: NotificationState) => void;
  notify: (message: string) => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);

  async function set(key: string, value: boolean) {
    if (!prefs) return;
    const before = prefs;
    onPrefs({ ...prefs, prefs: { ...prefs.prefs, [key]: value } });
    if (demo) return;
    setSaving(key);
    try {
      onPrefs(await api.saveNotificationPrefs(company, { [key]: value }));
    } catch (err) {
      onPrefs(before);
      notify((err as Error).message || "Não foi possível salvar.");
    } finally {
      setSaving(null);
    }
  }

  async function pause(choice: PauseChoice | null) {
    setPausing(true);
    try {
      await onPause(choice);
    } finally {
      setPausing(false);
    }
  }

  const paused = isPaused(prefs);
  return (
    <section
      className="panel profile-card connected-apps notify-settings"
      id="notificacoes"
    >
      <div className="panel-heading">
        <div>
          <h2>
            <BellRing size={18} /> Notificações
          </h2>
          <p>
            Escolha o que você quer receber. Vale para todos os seus
            navegadores e celulares. Um aviso desligado não chega nem na caixa
            de entrada; para só silenciar por um tempo, use a pausa.
          </p>
        </div>
      </div>

      <div className="notify-settings-browser">
        <div>
          <strong>Neste navegador</strong>
          <span>
            {state === "on"
              ? "Notificações ativadas."
              : state === "default"
                ? "Notificações ainda não ativadas."
                : state === "denied"
                  ? "Notificações bloqueadas. Libere pelo ícone à esquerda do endereço › Notificações › Permitir, e recarregue a página."
                  : "Este navegador não mostra notificações. No iPhone e no iPad, instale o app na Tela de Início."}
          </span>
        </div>
        {state === "default" && (
          <Button
            className="btn primary"
            onClick={() => void enableNotifications().then(onState)}
          >
            Ativar notificações
          </Button>
        )}
      </div>

      <div className="notify-settings-browser">
        <div>
          <strong>Pausa</strong>
          <span>
            {paused && prefs?.paused_until
              ? `Pausadas ${pauseLabel(prefs.paused_until)}: os avisos vão só para a caixa de entrada.`
              : "Silencia as notificações do navegador por um tempo, em todos os seus dispositivos."}
          </span>
        </div>
        {paused ? (
          <Button
            className="btn secondary"
            loading={pausing}
            onClick={() => void pause(null)}
          >
            Retomar
          </Button>
        ) : (
          <div className="notify-pause">
            {(
              [
                ["hour", "1 hora"],
                ["tomorrow", "Até amanhã"],
                ["forever", "Até eu retomar"],
              ] as const
            ).map(([choice, label]) => (
              <Button
                key={choice}
                disabled={!prefs || pausing}
                onClick={() => void pause(choice)}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
      </div>

      {!prefs ? (
        <Skeleton className="notify-settings-skeleton" />
      ) : (
        <>
          <div className="notify-settings-group">
            <h3>Avisos</h3>
            <ul className="notify-types">
              {NOTICE_TYPES.map((t) => {
                const on = prefs.prefs[t.key] ?? true;
                return (
                  <li key={t.key}>
                    <div>
                      <strong>{t.label}</strong>
                      <small>{t.hint}</small>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={t.label}
                      className={`template-switch${on ? " on" : ""}`}
                      disabled={saving === t.key}
                      onClick={() => void set(t.key, !on)}
                    >
                      <span aria-hidden="true" />
                      {on ? "Ligado" : "Desligado"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="notify-settings-group">
            <h3>Mudanças de status</h3>
            <p>
              Receba quando alguém mover uma tarefa para um destes status,
              conforme o seu papel nela. Você não é avisado do que você mesmo
              mudou.
            </p>
            <div className="notify-grid-wrap">
              <table className="notify-grid">
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    {STATUS_ROLES.map((r) => (
                      <th key={r.role} scope="col" title={r.hint}>
                        {r.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {STATUS_ROWS.map((s) => (
                    <tr key={s.status}>
                      <th scope="row">{s.label}</th>
                      {STATUS_ROLES.map((r) => {
                        const key = statusKey(s.status, r.role);
                        return (
                          <td key={r.role}>
                            <Checkbox
                              checked={!!prefs.prefs[key]}
                              disabled={saving === key}
                              aria-label={`${s.label} — ${r.hint}`}
                              onCheckedChange={(v) => void set(key, v === true)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <small className="connected-note">
              “Criei”: tarefas que você criou. “Sou responsável”: tarefas em que
              você é o responsável. “Participo”: tarefas em que você foi
              mencionado ou já foi responsável. Os avisos do Mural seguem o
              formato escolhido por quem publica.
            </small>
          </div>
        </>
      )}
    </section>
  );
}
