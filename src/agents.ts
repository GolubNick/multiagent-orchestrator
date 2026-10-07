import { Agent, tool } from "@openai/agents";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AppConfig } from "./config.js";
import { fetchPage } from "./fetcher.js";
import { createModel } from "./model.js";
import { Skill } from "./skill.js";

const execFileAsync = promisify(execFile);

const fetchPageTool = tool({
  name: "fetch_page",
  description: "Fetch a URL and return its readable text content.",
  parameters: z.object({
    url: z.string().describe("The URL to fetch"),
    maxChars: z.number().optional().describe("Maximum characters to return (default 15000)"),
  }),
  execute: async ({ url, maxChars }) => {
    const page = await fetchPage(url, maxChars ?? 15000);
    return `URL: ${page.url}\n${page.text}`;
  },
});

const runCommandTool = tool({
  name: "run_command",
  description:
    "Execute a shell command via PowerShell on the local machine and return stdout/stderr. Use for running CLI tools (Playwright, npm), creating files, inspecting the project. Supports PowerShell syntax (New-Item, Set-Content, node one-liners). The optional cwd parameter sets the working directory (absolute path); if omitted, the project directory is used. Always use cwd = OUTPUT_DIR/autotests for the autotests project.",
  parameters: z.object({
    command: z.string().describe("The PowerShell command to execute"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory (absolute path). Use for the autotests project (OUTPUT_DIR/autotests)"),
    timeoutMs: z.number().optional().describe("Timeout in milliseconds, default 600000"),
  }),
  execute: async ({ command, cwd, timeoutMs }) => {
    const ps = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`;
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    try {
      const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encoded,
        ],
        {
          cwd: cwd ?? process.cwd(),
          timeout: timeoutMs ?? 600000,
          maxBuffer: 50 * 1024 * 1024,
          windowsHide: true,
        },
      );
      const out = `${stdout}\n${stderr}`.trim();
      return out.length > 30000 ? `${out.slice(0, 30000)}\n...[truncated]` : out;
    } catch (error) {
      const e = error as {
        message?: string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      const toStr = (v?: string | Buffer) => (v ? String(v).slice(-5000) : "");
      return `COMMAND FAILED: ${e.message}\nSTDOUT: ${toStr(e.stdout)}\nSTDERR: ${toStr(e.stderr)}`;
    }
  },
});

const createJiraIssueTool = tool({
  name: "create_jira_issue",
  description:
    "Create an issue (Epic, Story, Task, Bug) in Jira via the Jira REST API. Requires JIRA_BASE_URL and JIRA_API_TOKEN (plus JIRA_EMAIL for basic auth) env vars. Returns the created issue key and URL.",
  parameters: z.object({
    projectKey: z.string().describe("Jira project key, e.g. PROJ"),
    issueType: z.string().describe("Issue type name, e.g. Epic, Story, Task, Bug"),
    summary: z.string().describe("Issue summary/title"),
    description: z.string().optional().describe("Issue description, one item per line"),
    priority: z.string().optional().describe("Priority name, e.g. High, Medium, Low"),
    parentKey: z.string().optional().describe("Parent issue key (e.g. the Epic key) to link stories to"),
  }),
  execute: async ({ projectKey, issueType, summary, description, priority, parentKey }) => {
    const baseUrl = (process.env.JIRA_BASE_URL ?? "").replace(/\/+$/, "");
    const email = process.env.JIRA_EMAIL ?? "";
    const apiToken = process.env.JIRA_API_TOKEN ?? "";

    if (!baseUrl || !apiToken) {
      return "Jira is not configured. Set JIRA_BASE_URL and JIRA_API_TOKEN (and JIRA_EMAIL) in the .env file.";
    }

    const auth = email
      ? `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`
      : `Bearer ${apiToken}`;

    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      issuetype: { name: issueType },
      summary,
    };
    if (description) {
      fields.description = {
        type: "doc",
        version: 1,
        content: description.split("\n").map((line) => ({
          type: "paragraph",
          content: [{ type: "text", text: line }],
        })),
      };
    }
    if (priority) fields.priority = { name: priority };
    if (parentKey) fields.parent = { key: parentKey };

    const res = await fetch(`${baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      return `Jira create failed: ${res.status} ${await res.text()}`;
    }

    const data = (await res.json()) as { key: string; id: string };
    return `Created ${data.key}: ${baseUrl}/browse/${data.key}`;
  },
});

const PLANNER_RULES = `Break the work into 3-8 independent subtasks that can be executed in parallel.
Each subtask must be self-contained and not depend on the results of others.
Return ONLY a JSON array without any explanations, with each element in the form:
{"title": "Short name", "description": "Detailed description of the subtask and its expected result"}`;

const BASE_RULES = `If the message contains "=== WEBSITE CONTENT ===", treat it as the ACTUAL content of the analyzed website fetched automatically — base your analysis on this real content, cite concrete details from it, and never invent specifics that contradict it.
If no website content is provided, use your own knowledge but explicitly note that the data is approximate.
Return only the result of your task, without general reasoning.`;

export interface PhaseAgents {
  name: string;
  planner?: Agent;
  worker?: Agent;
  agent?: Agent;
}

export interface SkillAgentSet {
  name: string;
  phases: PhaseAgents[];
  aggregator: Agent;
}

export function buildAgents(
  config: AppConfig,
  skill: Skill,
  outputDir?: string,
): SkillAgentSet {
  const plannerModel = createModel(config.planner);
  const workerModel = createModel(config.worker);
  const aggregatorModel = createModel(config.aggregator);

  const autotestsDir = outputDir ? path.join(outputDir, "autotests") : process.cwd();
  const sub = (text: string) => text.replaceAll("OUTPUT_DIR", autotestsDir);

  const phases: PhaseAgents[] = skill.phases.map((phase) => {
    const agents: PhaseAgents = { name: phase.name };

    if (phase.planner) {
      agents.planner = new Agent({
        name: `${phase.name} Planner`,
        model: plannerModel,
        instructions: `${sub(phase.planner)}\n\n${PLANNER_RULES}`,
        tools: [fetchPageTool],
        modelSettings: { temperature: 0.2 },
      });
    }

    if (phase.worker) {
      agents.worker = new Agent({
        name: `${phase.name} Worker`,
        model: workerModel,
        instructions: `${sub(phase.worker)}\n\n${BASE_RULES}`,
        tools: [fetchPageTool, runCommandTool, createJiraIssueTool],
      });
    }

    if (phase.agent) {
      agents.agent = new Agent({
        name: phase.name,
        model: plannerModel,
        instructions: `${sub(phase.agent)}\n\n${BASE_RULES}`,
        tools: [fetchPageTool, runCommandTool, createJiraIssueTool],
      });
    }

    return agents;
  });

  const aggregator = new Agent({
    name: "Aggregator",
    model: aggregatorModel,
    instructions: skill.aggregator,
  });

  return { name: skill.name, phases, aggregator };
}
