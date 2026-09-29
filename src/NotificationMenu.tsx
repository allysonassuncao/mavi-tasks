import * as Popover from "@radix-ui/react-popover";
import {
  Bell,
  BellOff,
  BellRing,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Loader2,
  RotateCw,
  Send,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  notificationEnvironment,
  setNotificationsOn,
  showTestNotification,
  toggleNotifications,
  type NotificationState,
} from "./notifications";
import { connectPush } from "./push";
import { Button } from "./ui";

type Step = {
  label: string;
  status: "ok" | "fail" | "skip" | "wait";
  text: string;
};
type ServerTest = () => Promise<{
  configured: boolean;
  browsers: number;
  sent: boolean;
}>;

/** Where to allow the browser's notifications in the system. */
function systemHelp() {
  const { system, browser } = notificationEnvironment();
  if (system === "mac")
    return `No Mac, abra Ajustes do Sistema › Notificações › ${browser} e ative "Permitir notificações", com o estilo "Faixas" ou "Alertas". Confira também se o Foco (Não perturbar) está desligado.`;
  if (system === "windows")
    return `No Windows, abra Configurações › Sistema › Notificações, ative as notificações e o ${browser} na lista de apps. Confira também se o "Não perturbar" está desligado.`;
  return `Confira nas configurações do sistema se o ${browser} pode mostrar notificações e se o modo Não perturbar está desligado.`;
}

/** Where to unblock the site in the browser. */
function siteHelp() {
  const { browser } = notificationEnvironment();
  return browser === "Safari"
    ? `No Safari, abra Ajustes › Sites › Notificações, escolha "Permitir" para ${location.host} e recarregue a página.`
    : `Clique no ícone à esquerda do endereço (cadeado ou ajustes) › Notificações › Permitir, e recarregue a página.`;
}

async function pushSteps(
  state: NotificationState,
  serverTest: ServerTest,
): Promise<Step> {
  const label = "Com o app fechado";
  if (state === "off")
    return {
      label,
      status: "skip",
      text: "Notificações pausadas: retome para receber com o app fechado.",
    };
  const push = await connectPush(true);
  if (push.state === "unsupported")
    return {
      label,
      status: "skip",
      text: "Este navegador não recebe avisos com o app fechado.",
    };
  if (push.state === "no-worker")
    return {
      label,
      status: "fail",
      text: "O serviço em segundo plano do app não está ativo neste navegador. Recarregue a página; se continuar, confira se não é uma janela anônima.",
    };
  if (push.state === "server-off")
    return {
      label,
      status: "fail",
      text: "O servidor ainda não tem as chaves de envio. Avise o administrador do sistema.",
    };
  if (push.state !== "on")
    return {
      label,
      status: "fail",
      text: `O navegador não aceitou o registro${push.error ? `: ${push.error}` : "."}`,
    };
  try {
    const result = await serverTest();
    if (!result.configured)
      return {
        label,
        status: "fail",
        text: "O envio ainda não está ligado no banco (mavi_private.push_config). Avise o administrador do sistema.",
      };
    if (!result.sent)
      return {
        label,
        status: "fail",
        text: "Este navegador não ficou registrado para você. Tente de novo.",
      };
    return {
      label,
      status: "ok",
      text: `Enviada pelo servidor para ${result.browsers} ${result.browsers === 1 ? "navegador seu" : "navegadores seus"}. Deve aparecer em alguns segundos, com o título "Teste de notificação".`,
    };
  } catch (err) {
    return {
      label,
      status: "fail",
      text: `O servidor não respondeu: ${(err as Error)?.message || err}`,
    };
  }
}

/**
 * The bell in the top bar: turns this browser's notifications on, pauses
 * them, and "Enviar notificação de teste" checks each link of the chain —
 * permission, the system showing it, the service worker, the push through
 * the server — and says what to fix when one fails.
 */
export function NotificationMenu({
  state,
  onState,
  serverTest,
}: {
  state: NotificationState;
  onState: (state: NotificationState) => void;
  /** Push through the server; absent in the demo. */
  serverTest?: ServerTest;
}) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const [testing, setTesting] = useState(false);
  const [local, setLocal] = useState<Step | null>(null);
  const [seen, setSeen] = useState<boolean | null>(null);
  const [push, setPush] = useState<Step | null>(null);

  async function enable() {
    const next = await toggleNotifications();
    setAsked(true);
    onState(next);
  }

  async function test() {
    setTesting(true);
    setSeen(null);
    setPush(null);
    const shown = await showTestNotification();
    setLocal({
      label: "Neste navegador",
      status: shown ? "wait" : "fail",
      text: shown
        ? "Enviada agora, no canto da tela. Ela apareceu?"
        : "O navegador recusou a notificação. Recarregue a página e tente de novo.",
    });
    if (serverTest) setPush(await pushSteps(state, serverTest));
    setTesting(false);
  }

  const Icon =
    state === "on" ? BellRing : state === "default" ? Bell : BellOff;
  const title = {
    unsupported: "",
    default:
      "Receber um aviso quando uma tarefa for criada para você ou quando mencionarem você",
    on: "Notificações ativadas",
    off: "Notificações pausadas",
    denied: "Notificações bloqueadas neste navegador",
  }[state];

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setLocal(null);
          setPush(null);
          setSeen(null);
        }
      }}
    >
      <Popover.Trigger asChild>
        <Button
          className={`notify-toggle ${state}`}
          aria-pressed={state === "on"}
          title={title}
        >
          <Icon size={17} />
          {state === "default" && <span>Ativar notificações</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Content
        className="inbox-panel notify-panel"
        align="end"
        sideOffset={8}
        collisionPadding={10}
      >
        <header>
          <strong>Notificações do navegador</strong>
        </header>
        <div className="notify-body">
          {state === "default" && (
            <>
              <p>
                Ainda não ativadas neste navegador. Com elas, você recebe um
                aviso quando criarem uma tarefa para você, quando mencionarem
                você e nos demais avisos da caixa de entrada — mesmo com o app
                fechado.
              </p>
              <Button className="btn primary" onClick={() => void enable()}>
                <Bell size={15} /> Ativar notificações
              </Button>
              {asked && (
                <p className="notify-hint">
                  O navegador não mostrou o pedido de permissão. Procure um
                  sino riscado na barra de endereço e escolha “Permitir”, ou
                  libere pelo ícone à esquerda do endereço › Notificações ›
                  Permitir.
                </p>
              )}
            </>
          )}
          {state === "denied" && (
            <>
              <p>
                <strong>Bloqueadas para este site no navegador.</strong> O app
                não consegue pedir de novo: é preciso liberar no navegador.
              </p>
              <p className="notify-hint">{siteHelp()}</p>
              <Button
                className="btn secondary"
                onClick={() => location.reload()}
              >
                <RotateCw size={15} /> Recarregar página
              </Button>
            </>
          )}
          {(state === "on" || state === "off") && (
            <>
              <div className="notify-status">
                <span className={`notify-dot ${state}`} />
                {state === "on"
                  ? "Ativadas neste navegador."
                  : "Pausadas neste navegador."}
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => onState(setNotificationsOn(state === "off"))}
                >
                  {state === "on" ? "Pausar" : "Retomar"}
                </button>
              </div>
              <Button
                className="btn secondary"
                loading={testing}
                onClick={() => void test()}
              >
                <Send size={15} /> Enviar notificação de teste
              </Button>
              {local && (
                <ul className="notify-steps">
                  <StepRow
                    step={{
                      ...local,
                      status:
                        seen === true ? "ok" : seen === false ? "fail" : local.status,
                    }}
                  >
                    {local.status === "wait" && seen === null && (
                      <span className="notify-answer">
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() => setSeen(true)}
                        >
                          Sim
                        </button>
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() => setSeen(false)}
                        >
                          Não apareceu
                        </button>
                      </span>
                    )}
                    {seen === true && <p>Tudo certo neste navegador.</p>}
                    {seen === false && (
                      <p className="notify-hint">
                        O navegador entregou a notificação, mas o sistema não a
                        mostrou. {systemHelp()}
                      </p>
                    )}
                  </StepRow>
                  {testing && !push && serverTest && (
                    <StepRow
                      step={{
                        label: "Com o app fechado",
                        status: "wait",
                        text: "Testando o envio pelo servidor…",
                      }}
                      busy
                    />
                  )}
                  {push && <StepRow step={push} />}
                </ul>
              )}
            </>
          )}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

function StepRow({
  step,
  busy,
  children,
}: {
  step: Step;
  busy?: boolean;
  children?: ReactNode;
}) {
  const Icon = busy
    ? Loader2
    : step.status === "ok"
      ? CheckCircle2
      : step.status === "fail"
        ? CircleAlert
        : CircleDashed;
  return (
    <li className={`notify-step ${step.status}`}>
      <Icon size={16} className={busy ? "spin" : undefined} />
      <div>
        <strong>{step.label}</strong>
        <p>{step.text}</p>
        {children}
      </div>
    </li>
  );
}
