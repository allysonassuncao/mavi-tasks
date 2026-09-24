/**
 * A picture of what the person sees now (the visible part of the page),
 * drawn from the page itself — no screen-sharing prompt. `hide` leaves
 * elements out of the picture, such as the dialog asking for it.
 */
export async function captureScreen(hide: Element[] = []): Promise<File> {
  const { domToCanvas } = await import("modern-screenshot");
  const root = document.documentElement;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const page = await domToCanvas(root, {
    scale,
    width: root.scrollWidth,
    height: root.scrollHeight,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    filter: (node) => !(node instanceof Element && hide.includes(node)),
    // An image that doesn't load in time is left blank, not the picture.
    timeout: 8000,
  });
  // Only the visible part, where the person is on the page.
  const width = window.innerWidth,
    height = window.innerHeight;
  const view = document.createElement("canvas");
  view.width = Math.round(width * scale);
  view.height = Math.round(height * scale);
  view
    .getContext("2d")!
    .drawImage(
      page,
      window.scrollX * scale,
      window.scrollY * scale,
      view.width,
      view.height,
      0,
      0,
      view.width,
      view.height,
    );
  const blob = await new Promise<Blob | null>((done) =>
    view.toBlob(done, "image/png"),
  );
  if (!blob) throw Error("Não foi possível gerar a captura de tela.");
  return new File([blob], screenshotName(new Date()), { type: "image/png" });
}

/** "captura-2026-09-24-14h05m30s.png" (local time). */
export function screenshotName(at: Date) {
  const two = (n: number) => String(n).padStart(2, "0");
  return `captura-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}h${two(at.getMinutes())}m${two(at.getSeconds())}s.png`;
}
