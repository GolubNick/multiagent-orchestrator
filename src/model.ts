import OpenAI from "openai";
import { OpenAIChatCompletionsModel } from "@openai/agents";
import { ProviderConfig } from "./types.js";

export function createModel(config: ProviderConfig): OpenAIChatCompletionsModel {
  const baseUrl =
    config.baseUrl ??
    (config.type === "ollama" ? "http://localhost:11434/v1" : "https://api.openai.com/v1");

  const client = new OpenAI({
    apiKey: config.apiKey ?? "not-needed",
    baseURL: baseUrl,
    maxRetries: 5,
  });

  return new OpenAIChatCompletionsModel(client, config.model);
}
