import "dotenv/config";
import { ProviderConfig, ProviderType } from "./types.js";

export interface AppConfig {
  planner: ProviderConfig;
  worker: ProviderConfig;
  aggregator: ProviderConfig;
  concurrency: number;
  skillsDir: string;
}

type Env = Record<string, string | undefined>;

function providerFromEnv(prefix: string, env: Env): ProviderConfig {
  const type = (env[`${prefix}_PROVIDER`] ?? "ollama") as ProviderType;
  const defaultModel = type === "ollama" ? "llama3.1" : "gpt-4o";
  return {
    type,
    model: env[`${prefix}_MODEL`] ?? defaultModel,
    baseUrl: env[`${prefix}_BASE_URL`] || undefined,
    apiKey: env[`${prefix}_API_KEY`] || undefined,
  };
}

export function loadConfig(): AppConfig {
  const env = process.env;
  return {
    planner: providerFromEnv("PLANNER", env),
    worker: providerFromEnv("WORKER", env),
    aggregator: providerFromEnv("AGGREGATOR", env),
    concurrency: Number(env.CONCURRENCY ?? "2"),
    skillsDir: env.SKILLS_DIR ?? "skills",
  };
}
