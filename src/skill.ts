import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface SkillPhase {
  name: string;
  planner?: string;
  worker?: string;
  agent?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  phases: SkillPhase[];
  aggregator: string;
}

export const DEFAULT_SKILL: Skill = {
  id: "generic",
  name: "Generic multi-agent task",
  description: "General-purpose decomposition and parallel execution for arbitrary tasks",
  keywords: [],
  phases: [
    {
      name: "Research",
      planner:
        "Break the user's task down into independent subtasks covering the main aspects of the request.",
      worker:
        "Thoroughly complete your subtask using the provided context. Produce concrete, specific results.",
    },
  ],
  aggregator: `Combine the subtask results into a single coherent, DETAILED final answer to the original task.
Produce a well-structured report with clear sections and headings, resolve contradictions, and merge duplicated information.
End with a prioritized list of concrete recommendations.`,
};

export async function loadSkills(dir = "skills"): Promise<Skill[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const content = await readFile(path.join(dir, file), "utf8");
    const skill = parseSkill(file, content);
    if (skill) skills.push(skill);
  }
  return skills;
}

export function resolveSkill(task: string, skills: Skill[]): Skill {
  const lower = task.toLowerCase();
  let best: Skill | null = null;
  let bestScore = 0;

  for (const skill of skills) {
    let score = 0;
    for (const keyword of skill.keywords) {
      if (matchesKeyword(lower, keyword.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }

  return best ?? DEFAULT_SKILL;
}

const PREFERRED_ORDER = [
  "business-analysis",
  "jira-scope",
  "manual-qa",
  "aqa-playwright",
];

export function resolveSkills(task: string, skills: Skill[]): Skill[] {
  const lower = task.toLowerCase();

  const scored = skills
    .map((skill) => ({
      skill,
      score: skill.keywords.filter((kw) =>
        matchesKeyword(lower, kw.toLowerCase()),
      ).length,
    }))
    .filter((entry) => entry.score > 0);

  if (scored.length === 0) return [DEFAULT_SKILL];

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = PREFERRED_ORDER.indexOf(a.skill.id);
    const pb = PREFERRED_ORDER.indexOf(b.skill.id);
    const ia = pa === -1 ? Number.MAX_SAFE_INTEGER : pa;
    const ib = pb === -1 ? Number.MAX_SAFE_INTEGER : pb;
    return ia - ib;
  });

  return scored.map((entry) => entry.skill);
}

function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escaped.endsWith("\\*")) {
    const prefix = escaped.slice(0, -2);
    return new RegExp(`(?<![\\p{L}\\p{N}_])${prefix}`, "iu").test(text);
  }
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

function parseSkill(filename: string, content: string): Skill | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  const body = content.slice(fmMatch[0].length);
  const sections = parseSections(body, /^##\s+(.+?)\s*$/gm);

  const phases: SkillPhase[] = [];
  for (const [title, text] of sections) {
    if (title === "Aggregator") continue;
    if (!title.startsWith("Phase:")) continue;

    const sub = parseSections(text, /^###\s+(.+?)\s*$/gm);
    phases.push({
      name: title.replace(/^Phase:\s*/, "").trim(),
      planner: sub.get("Planner"),
      worker: sub.get("Worker"),
      agent: sub.get("Agent"),
    });
  }

  const aggregator = sections.get("Aggregator") ?? "";
  if (phases.length === 0 || !aggregator.trim()) return null;

  return {
    id: fm.id ?? filename.replace(/\.md$/, ""),
    name: fm.name ?? fm.id ?? filename.replace(/\.md$/, ""),
    description: fm.description ?? "",
    keywords: parseKeywords(fm.keywords),
    phases,
    aggregator,
  };
}

function parseSections(text: string, regex: RegExp): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = [...text.matchAll(regex)];
  let last: string | null = null;
  let lastIndex = 0;

  for (const m of matches) {
    if (last) sections.set(last, text.slice(lastIndex, m.index).trim());
    last = m[1].trim();
    lastIndex = (m.index ?? 0) + m[0].length;
  }
  if (last) sections.set(last, text.slice(lastIndex).trim());

  return sections;
}

function parseKeywords(raw?: string): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String);
  } catch {
    // fall through to comma-separated parsing
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
