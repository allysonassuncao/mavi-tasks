/**
 * O título das tarefas novas: a MAVI escreve a partir da descrição e dos
 * áudios ao clicar em "Criar tarefa" (ação "task-title" de /api/drive,
 * funcionalidade 'task_title' do Painel da MAVI). Estas são as regras que o
 * navegador e o servidor compartilham.
 */
export const TASK_TITLE_MAX = 80;
/** Quanto o formulário espera pela MAVI antes de salvar com o título de reserva. */
export const TASK_TITLE_WAIT_MS = 8000;

/** A resposta da MAVI, limpa: uma linha, sem aspas, rótulo, markdown nem ponto final. */
export function cleanTaskTitle(text: string) {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const clean = line
    .replace(/[*_`#]/g, "")
    .replace(/^(t[ií]tulo|title)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    // Aspas e pontuação nas pontas, em qualquer ordem ("Título".).
    .replace(/^["'“”‘’«\s]+/, "")
    .replace(/["'“”‘’».;:,\s]+$/, "");
  return clip(clean);
}

/**
 * Sem a MAVI (falhou, demorou, sem provedor): o começo do que foi escrito
 * ou falado, até a primeira frase e no máximo 10 palavras.
 */
export function fallbackTaskTitle(text: string) {
  const plain = text.replace(/\s+/g, " ").trim();
  const sentence = plain.split(/(?<=[.!?])\s/)[0] ?? plain;
  const words = sentence.split(" ").filter(Boolean);
  const short = words.slice(0, 10).join(" ").replace(/[.;:,!?]+$/, "");
  const title = clip(short);
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "";
}

function clip(text: string) {
  if (text.length <= TASK_TITLE_MAX) return text;
  const cut = text.slice(0, TASK_TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > 40 ? cut.slice(0, space) : cut).replace(/[.;:,]+$/, "").trim();
}
