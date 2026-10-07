import { Agent, Runner } from "@openai/agents";
import { SkillAgentSet } from "./agents.js";
import { extractUrls, fetchPage } from "./fetcher.js";
import { OrchestrateResult, Subtask, SubtaskResult } from "./types.js";

let lastModelCallAt = 0;
const MIN_CALL_INTERVAL_MS = 1500;

async function paceModelCall(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, MIN_CALL_INTERVAL_MS - (now - lastModelCallAt));
  lastModelCallAt = now + wait;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

export class Orchestrator {
  private readonly runner: Runner;

  constructor(
    private readonly agents: SkillAgentSet,
    private readonly concurrency = 4,
  ) {
    this.runner = new Runner({ tracingDisabled: true });
  }

  async run(task: string, priorContext = ""): Promise<OrchestrateResult> {
    if (priorContext.length > 25000) {
      priorContext = `...[truncated] ${priorContext.slice(-25000)}`;
    }
    const context = await this.collectContext(task);
    const fullContext = priorContext
      ? `${context}\n\n=== PREVIOUS STAGES OUTPUT ===\n${priorContext}`
      : context;
    const allResults: SubtaskResult[] = [];

    for (const phase of this.agents.phases) {
      console.log(`\n[Phase] ${phase.name}...`);
      const resultsSoFar = this.resultsBlock(allResults);

      if (phase.planner && phase.worker) {
        try {
          const subtasks = await this.plan(
            task,
            fullContext,
            resultsSoFar,
            phase.planner,
          );
          const results = await this.dispatch(
            task,
            fullContext,
            resultsSoFar,
            subtasks,
            phase.worker,
          );
          allResults.push(...results);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[Phase] ${phase.name} PLANNING FAILED: ${message}`);
          allResults.push({
            subtask: {
              id: String(allResults.length + 1),
              title: `${phase.name} (planning)`,
              description: "",
            },
            output: "",
            ok: false,
            error: message,
          });
        }
      } else if (phase.agent) {
        const title = phase.name;
        try {
          const output = await this.callWithRetry(
            phase.agent,
            `Overall task:\n${task}${fullContext}${resultsSoFar}\n\nProduce: ${phase.name}`,
          );
          allResults.push({
            subtask: {
              id: String(allResults.length + 1),
              title,
              description: "",
            },
            output,
            ok: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[Phase] ${phase.name} FAILED: ${message}`);
          allResults.push({
            subtask: {
              id: String(allResults.length + 1),
              title,
              description: "",
            },
            output: "",
            ok: false,
            error: message,
          });
        }
      }
    }

    console.log("\nCompiling final report...");
    let final: string;
    try {
      final = await this.callWithRetry(
        this.agents.aggregator,
        `Original task:\n${task}${fullContext}\n\nWork results:\n${this.formatResults(allResults)}\n\nCompose the final detailed report.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Aggregator failed: ${message}`);
      final = `Final report could not be compiled (${message}).\n\nWork results:\n${this.formatResults(allResults)}`;
    }

    return { task, subtasks: allResults, final };
  }

  private async call(agent: Agent, input: string): Promise<string> {
    await paceModelCall();
    const result = await this.runner.run(agent, input);
    const output = result.finalOutput;
    return typeof output === "string" ? output : output == null ? "" : String(output);
  }

  private async callWithRetry(
    agent: Agent,
    input: string,
    maxAttempts = 8,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.call(agent, input);
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number })?.status;
        const retriable = status === 429 || (status !== undefined && status >= 500);
        if (!retriable || attempt === maxAttempts) throw error;

        const headers = (error as { headers?: Headers })?.headers;
        const retryAfter = headers?.get?.("retry-after");
        const parsed = retryAfter ? Number(retryAfter) : NaN;
        const delayMs = !Number.isNaN(parsed)
          ? parsed * 1000
          : Math.min(90000, 10000 * Math.pow(2, attempt - 1)) + Math.random() * 2000;
        console.warn(
          `[Retry] ${agent.name} attempt ${attempt}/${maxAttempts} failed (HTTP ${status}). Waiting ${Math.round(delayMs / 1000)}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  private async plan(
    task: string,
    context: string,
    resultsSoFar: string,
    plannerAgent: Agent,
  ): Promise<Subtask[]> {
    const raw = await this.callWithRetry(plannerAgent, `${task}${context}${resultsSoFar}`);
    return parseSubtasks(raw, plannerAgent.name);
  }

  private async dispatch(
    task: string,
    context: string,
    resultsSoFar: string,
    subtasks: Subtask[],
    workerAgent: Agent,
  ): Promise<SubtaskResult[]> {
    const results: SubtaskResult[] = new Array(subtasks.length);
    let next = 0;

    const runner = async (): Promise<void> => {
      while (next < subtasks.length) {
        const index = next++;
        results[index] = await this.runWorker(
          task,
          context,
          resultsSoFar,
          subtasks[index],
          workerAgent,
        );
      }
    };

    const poolSize = Math.max(1, Math.min(this.concurrency, subtasks.length));
    await Promise.all(Array.from({ length: poolSize }, runner));
    return results;
  }

  private async runWorker(
    task: string,
    context: string,
    resultsSoFar: string,
    subtask: Subtask,
    workerAgent: Agent,
  ): Promise<SubtaskResult> {
    try {
      const output = await this.callWithRetry(
        workerAgent,
        `Overall task:\n${task}${context}${resultsSoFar}\n\nYour subtask — ${subtask.title}:\n${subtask.description}`,
      );
      return { subtask, output, ok: true };
    } catch (error) {
      return {
        subtask,
        output: "",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resultsBlock(results: SubtaskResult[]): string {
    if (results.length === 0) return "";
    return `\n\n=== WORK COMPLETED SO FAR ===\n${this.formatResults(results)}\n=== END ===`;
  }

  private formatResults(results: SubtaskResult[]): string {
    return results
      .map((r) =>
        r.ok
          ? `### ${r.subtask.title}\n${r.output}`
          : `### ${r.subtask.title}\n[ERROR: ${r.error}]`,
      )
      .join("\n\n");
  }

  private async collectContext(task: string): Promise<string> {
    const urls = extractUrls(task);
    if (urls.length === 0) return "";

    const blocks: string[] = [];
    for (const url of urls.slice(0, 1)) {
      try {
        console.log(`Fetching ${url}...`);
        const page = await fetchPage(url, 15000);
        blocks.push(`URL: ${page.url}\n${page.text}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        blocks.push(`URL: ${url}\n[FETCH FAILED: ${message}]`);
      }
    }

    return `\n=== WEBSITE CONTENT (fetched automatically) ===\n${blocks.join("\n\n---\n\n")}\n=== END OF WEBSITE CONTENT ===`;
  }
}

function parseSubtasks(raw: string, agentName: string): Subtask[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `${agentName}: planner returned invalid JSON. Response: ${raw.slice(0, 500)}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${agentName}: planner did not return a list of subtasks`);
  }

  return parsed.map((item, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const title = String(entry.title ?? entry.name ?? `Subtask ${index + 1}`);
    const description = String(entry.description ?? entry.task ?? "");
    return { id: String(index + 1), title, description };
  });
}
