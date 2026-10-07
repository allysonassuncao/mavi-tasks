import { useLayoutEffect, useRef } from "react";

/**
 * HTML num shadow DOM: o estilo do documento não vaza para o app (nem o
 * contrário). O HTML vem do desenho dos documentos (mavi-doc-html), que
 * escapa todo o texto.
 */
export function ShadowHtml({ css, html, className }: { css: string; html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:block}${css}</style>${html}`;
  }, [css, html]);
  return <div ref={ref} className={className} />;
}
