import { NoticeAnimation, useAnimationImages } from "./NoticeAnimation";
import type { AnimationSpec } from "./notice-animation";

/**
 * O player com os links dos prints já pedidos (carregado sob demanda pelo
 * popup; a página do Mural usa o NoticeAnimation direto).
 */
export default function NoticeAnimationPlayer({
  spec,
  images,
  load,
  autoplay = true,
}: {
  spec: AnimationSpec;
  /** Os ids dos anexos que a animação mostra. */
  images: string[];
  load: (ids: string[]) => Promise<Record<string, string>>;
  autoplay?: boolean;
}) {
  const urls = useAnimationImages(images, load);
  return <NoticeAnimation spec={spec} images={urls} autoplay={autoplay} />;
}
