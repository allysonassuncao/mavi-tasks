import { createContext, useContext } from "react";
import type { Page } from "./router";

/**
 * Planejamento has two modules on the same engine: Social Leads and Social
 * Media. Each has its own product, squad and creative team
 * (social_leads_settings.module, migration 20261210090000_social_media);
 * briefings, plans and tasks belong to the contracted product, so the
 * module of a client is the module of its product.
 */
export type SlModule = "social_leads" | "social_media";
export interface SlModuleInfo {
  id: SlModule;
  /** The module's name in the interface ("Social Leads"). */
  name: string;
  page: Extract<Page, "onboarding" | "socialMedia">;
  /** The Drive folder, under the contracted product, of the briefing's files. */
  briefingFolder: string;
}
export const SL_MODULES: Record<SlModule, SlModuleInfo> = {
  social_leads: {
    id: "social_leads",
    name: "Social Leads",
    page: "onboarding",
    briefingFolder: "Briefing Social Leads",
  },
  social_media: {
    id: "social_media",
    name: "Social Media",
    page: "socialMedia",
    briefingFolder: "Briefing Social Media",
  },
};
export const SlModuleContext = createContext<SlModule>("social_leads");
/** The module of the page open (Social Leads outside one). */
export function useSlModule() {
  return SL_MODULES[useContext(SlModuleContext)];
}
