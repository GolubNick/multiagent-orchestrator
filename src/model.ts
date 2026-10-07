import OpenAI from "openai";
import { OpenAIChatCompletionsModel } from "@openai/agents";
import { randomUUID } from "node:crypto";
import { ProviderConfig } from "./types.js";

const SESSION_ID = randomUUID();

export function createModel(config: ProviderConfig): OpenAIChatCompletionsModel {
  const baseUrl =
    config.baseUrl ??
    (config.type === "ollama" ? "http://localhost:11434/v1" : "https://api.openai.com/v1");

  const defaultHeaders: Record<string, string> = {};
  if (baseUrl.includes("opencode.ai")) {
    defaultHeaders["User-Agent"] = "multiagent-orchestrator/0.1.0";
    defaultHeaders["x-opencode-session"] = SESSION_ID;
  }

  const client = new OpenAI({
    apiKey: config.apiKey ?? "not-needed",
    baseURL: baseUrl,
    maxRetries: 5,
    defaultHeaders,
  });

  return new OpenAIChatCompletionsModel(client, config.model);
}
