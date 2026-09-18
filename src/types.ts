export type Status = "open" | "progress" | "returned" | "review" | "done";
export type Role = "admin" | "manager" | "member";
export interface Company {
  id: string;
  name: string;
  timezone: string;
}
export interface Member {
  company_id: string;
  user_id: string;
  name: string;
  role: Role;
  active: boolean;
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
}
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
  revision: number;
  version: number;
  archived: boolean;
  created_at: string;
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
  teamMembers: { company_id: string; team_id: string; user_id: string }[];
  contractTeams: { company_id: string; contract_id: string; team_id: string }[];
}
export const statuses: Record<Status, { label: string; color: string }> = {
  open: { label: "Aberto", color: "#7c8796" },
  progress: { label: "Em andamento", color: "#598bda" },
  returned: { label: "Devolvida", color: "#db8757" },
  review: { label: "Em validação", color: "#9a7cd3" },
  done: { label: "Entregue", color: "#4f9879" },
};
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
  contractTeams: [],
};
