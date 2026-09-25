import { fold } from "./domain";
import type { Client } from "./types";

/**
 * "Adicionar MAVI": the Make's MAVI joins a call as a participant, records it
 * and transcribes it. MASO receives the invitation on this webhook (it
 * accepts the app's origin, so the browser calls it directly).
 */
export const MAVI_WEBHOOK =
  "https://api.maso.app.br/webhook/06e50528-08eb-4333-af6c-e223b314cac0";

export interface MaviInvite {
  user_email: string;
  link_meet: string;
  /** The client's id, when the meeting is about one. */
  customer_id: string | null;
  customer_name: string | null;
}

/** A web address a bot can join (http or https, with a host). */
export function meetingLink(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes("."))
      return null;
    return url.href;
  } catch {
    return null;
  }
}

const words = (text: string) =>
  ` ${fold(text)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

/**
 * The client an event is about, from its title (first) or description: the
 * active client whose whole name appears in it — the longest one when
 * several do ("Açaí da Praça" over "Praça"). Names under 3 letters are
 * ignored, too likely to match by chance.
 */
export function clientFromEvent(
  clients: Client[],
  title: string,
  description = "",
): Client | null {
  const names = clients
    .filter((c) => !c.archived)
    .map((c) => ({ client: c, name: words(c.name) }))
    .filter((c) => c.name.trim().length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  for (const text of [title, description]) {
    const haystack = words(text);
    const hit = names.find((c) => haystack.includes(c.name));
    if (hit) return hit.client;
  }
  return null;
}

export function maviInvite(
  userEmail: string,
  link: string,
  client?: Client | null,
): MaviInvite {
  return {
    user_email: userEmail,
    link_meet: link,
    customer_id: client?.id ?? null,
    customer_name: client?.name ?? null,
  };
}

/** Sends the invitation; throws a message fit to show when it fails. */
export async function inviteMavi(invite: MaviInvite): Promise<void> {
  let response: Response;
  try {
    response = await fetch(MAVI_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invite),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw Error(
      "Não foi possível falar com a MAVI agora. Confira a conexão e tente de novo.",
    );
  }
  if (!response.ok)
    throw Error(
      `A MAVI não aceitou o convite (erro ${response.status}). Tente de novo em instantes.`,
    );
}
