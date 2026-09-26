export type Status =
  | "open"
  | "progress"
  | "returned"
  | "rejected"
  | "correction"
  | "review"
  | "done";
export type Role = "admin" | "manager" | "member";
export interface Company {
  id: string;
  name: string;
  timezone: string;
  /** Workspace image (public URL); initials are shown when absent. */
  logo_url?: string | null;
}
export interface Member {
  company_id: string;
  user_id: string;
  name: string;
  email?: string;
  role: Role;
  active: boolean;
  /** Profile photo (public URL); initials are shown when absent. */
  avatar_url?: string | null;
  /** Modules an administrator hid from the person (src/modules.ts). */
  hidden_pages?: string[];
}
export interface Client {
  id: string;
  company_id: string;
  name: string;
  email: string;
  color: string;
  archived: boolean;
}
export interface Product {
  id: string;
  company_id: string;
  name: string;
  color: string;
  /**
   * Whether creating a task in this product shows the "Projeto" field (when
   * the contracted product has projects). Leaders choose; on by default.
   */
  task_project_field?: boolean;
}
export interface Contract {
  id: string;
  company_id: string;
  client_id: string;
  product_id: string;
  name: string;
  archived: boolean;
}
export interface Project {
  id: string;
  company_id: string;
  contract_id: string;
  name: string;
  due_date: string | null;
  archived: boolean;
  /** Whether tasks go through validation before being done. */
  requires_review: boolean;
  /** Who validates when requires_review: the task creator or the team supervisor. */
  approver: ProjectApprover;
}
export type ProjectApprover = "creator" | "supervisor";
export interface Team {
  id: string;
  company_id: string;
  name: string;
}
export interface Task {
  id: string;
  company_id: string;
  contract_id: string;
  project_id: string | null;
  team_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  status: Status;
  priority: "low" | "normal" | "high" | "urgent";
  creator_id: string;
  assignee_id: string;
  due_date: string;
  original_due_date: string;
  start_date?: string | null;
  estimated_minutes: number;
  requires_client_approval: boolean;
  internal_approved_by: string | null;
  client_approved_by: string | null;
  client_approval_note: string | null;
  delivered_at: string | null;
  /** When the task entered its current status. */
  status_changed_at?: string;
  /** Everyone who was ever responsible or was mentioned in it. */
  participant_ids?: string[];
  /** Template fields filled in when the task was created (its own copy). */
  custom_fields?: TaskCustomField[];
  /** The repetition this task started or was opened by (see TaskRecurrence). */
  recurrence_id?: string | null;
  revision: number;
  version: number;
  archived: boolean;
  created_at: string;
}
/** A notice for one person, e.g. they were mentioned in a comment. */
export interface AppNotification {
  id: string;
  /** "social_leads": a plan the AI finished (or failed) writing. */
  kind: "mention" | "assigned" | "reply" | "social_leads";
  /** Null for notices that aren't about a task (they carry a link). */
  task_id: string | null;
  /** The task's title, or the notice's own title. */
  task_title: string;
  actor_id: string | null;
  actor_name: string | null;
  excerpt: string | null;
  read_at: string | null;
  created_at: string;
  /** Where the notice opens, when it isn't a task. */
  link?: string | null;
}
export interface TimeEntry {
  id: string;
  company_id: string;
  task_id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  note: string;
  source: "timer" | "manual";
}
export interface Comment {
  id: string;
  company_id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: string;
  /** The conversation's first comment, when this is a reply. */
  parent_id?: string | null;
}
export interface Attachment {
  id: string;
  company_id: string;
  task_id: string;
  name: string;
  path: string;
  size_bytes: number;
  uploaded_by: string;
}
/** How a task repeats: the database opens a copy on each date. */
export type RecurrenceFrequency =
  "daily" | "weekdays" | "weekly" | "biweekly" | "monthly";
export const recurrenceFrequencies: Record<RecurrenceFrequency, string> = {
  daily: "Todos os dias",
  weekdays: "Todos os dias úteis",
  weekly: "Semanal",
  biweekly: "Quinzenal",
  monthly: "Mensal",
};
/** A task's repetition, as its details show it (from task_extras). */
export interface TaskRecurrence {
  id: string;
  frequency: RecurrenceFrequency;
  /** The date the next copy opens. */
  next_run: string;
  active: boolean;
  creator_id: string;
  copies: number;
  /** Why the last copy couldn't open (tried again on the next run). */
  last_error: string | null;
}
export interface TaskEvent {
  id: string;
  task_id: string;
  actor_id: string;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}
export interface Snapshot {
  companies: Company[];
  members: Member[];
  clients: Client[];
  products: Product[];
  contracts: Contract[];
  projects: Project[];
  teams: Team[];
  tasks: Task[];
  hours: TimeEntry[];
  teamMembers: {
    company_id: string;
    team_id: string;
    user_id: string;
    /** Validates the team's tasks in projects set to "Supervisor da equipe". */
    supervisor?: boolean;
  }[];
  clientTeams: { company_id: string; client_id: string; team_id: string }[];
  /** Custom fields for new tasks, by product and/or team (see TaskTemplate). */
  taskTemplates: TaskTemplate[];
  /** Where suggestions become tasks (one row at most; see Suggestions). */
  suggestionSettings?: SuggestionSettings[];
}
/** The P&D team that receives suggestions, and where its tasks live. */
export interface SuggestionSettings {
  company_id: string;
  team_id: string;
  contract_id: string;
  project_id: string | null;
}
export type CustomFieldType =
  | "text"
  | "textarea"
  | "url"
  | "number"
  | "date"
  | "select"
  | "multiselect"
  | "checkbox";
/** A field of a template, as configured. */
export interface TemplateField {
  /** Stable within its template: values are keyed by it. */
  id: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  /** For select and multiselect. */
  options?: string[];
  help?: string;
}
/**
 * Extra fields a task must (or may) carry, configured by leaders. It applies
 * to a new task when its product is the task's and its team is one of the
 * assignee's (null = any); every matching template adds its fields.
 */
export interface TaskTemplate {
  id: string;
  company_id: string;
  name: string;
  product_id: string | null;
  team_id: string | null;
  fields: TemplateField[];
  active: boolean;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}
/** A value as stored: text, number, date (YYYY-MM-DD), options or yes. */
export type CustomValue = string | number | boolean | string[] | null;
/** A field as a task carries it: copied from its template, with the value. */
export interface TaskCustomField extends TemplateField {
  template_id: string;
  template_name: string;
  value?: CustomValue;
}
/**
 * Status keys predate the free flow and were kept: "rejected" is Alteração.
 * "open" (Em delegação) was retired — tasks start Em andamento — and stays
 * only so older history still reads. In menu order; Entregue is the closed one.
 */
export const statuses: Record<Status, { label: string; color: string }> = {
  open: { label: "Em delegação", color: "#7c8796" },
  progress: { label: "Em andamento", color: "#598bda" },
  returned: { label: "Devolvida", color: "#db8757" },
  review: { label: "Em validação", color: "#9a7cd3" },
  rejected: { label: "Alteração", color: "#cf4f5f" },
  correction: { label: "Correção", color: "#c28a1e" },
  done: { label: "Entregue", color: "#4f9879" },
};
/** Statuses a task moves between freely until it is delivered. */
export const workingStatuses: Status[] = [
  "progress",
  "returned",
  "review",
  "rejected",
  "correction",
];
/** Statuses offered in filters and board columns (the retired one left out). */
export const listedStatuses: Status[] = [...workingStatuses, "done"];
export const priorities = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};
export const emptySnapshot: Snapshot = {
  companies: [],
  members: [],
  clients: [],
  products: [],
  contracts: [],
  projects: [],
  teams: [],
  tasks: [],
  hours: [],
  teamMembers: [],
  clientTeams: [],
  taskTemplates: [],
};
export type DriveVisibility = "private" | "public";
export interface DriveFile {
  id: string;
  company_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  visibility: DriveVisibility;
  share_token: string;
  status: "pending" | "ready";
  uploaded_by: string;
  created_at: string;
  client_id: string | null;
  contract_id: string | null;
  folder_id: string | null;
}
export interface DriveFolder {
  id: string;
  company_id: string;
  client_id: string | null;
  contract_id: string | null;
  parent_id: string | null;
  name: string;
  created_by: string;
  created_at: string;
  /** "public": anyone with /pasta/<share_token> views it (read-only). */
  visibility?: DriveVisibility;
  share_token?: string;
}
/** Who a folder is shared with, as the sharing dialog edits it. */
export interface DriveFolderSharing {
  visibility: DriveVisibility;
  share_token: string;
  members: string[];
}
/** One level of a publicly shared folder (/pasta/<token>). */
export interface PublicFolderView {
  root: { id: string; name: string };
  folder: string;
  /** From the shared folder down to the one shown. */
  path: { id: string; name: string }[];
  folders: { id: string; name: string }[];
  files: {
    id: string;
    name: string;
    content_type: string;
    size_bytes: number;
    created_at: string;
  }[];
}
/** Where an item lives in the Drive tree; all empty means the root. */
export interface DriveLocation {
  client?: string;
  contract?: string;
  folder?: string;
}
export interface DriveAuditEntry {
  id: number;
  company_id: string;
  actor_id: string | null;
  action: string;
  file_id: string | null;
  folder_id: string | null;
  item_name: string | null;
  client_id: string | null;
  contract_id: string | null;
  details: Record<string, unknown> & {
    origin?: { ip?: string; user_agent?: string };
  };
  created_at: string;
}
