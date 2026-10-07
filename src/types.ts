export type ProviderType = "openai" | "ollama";

export interface ProviderConfig {
  type: ProviderType;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
}

export interface SubtaskResult {
  subtask: Subtask;
  output: string;
  ok: boolean;
  error?: string;
}

export interface OrchestrateResult {
  task: string;
  subtasks: SubtaskResult[];
  final: string;
}
