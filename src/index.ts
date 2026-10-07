import { loadConfig } from "./config.js";
import { buildAgents } from "./agents.js";
import { Orchestrator } from "./orchestrator.js";
import { loadSkills, resolveSkill, resolveSkills, Skill } from "./skill.js";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv: string[]): { task: string; skillsArg?: string } {
  const skillsArg = argv.find((a) => a.startsWith("--skills="))?.slice("--skills=".length);
  const task = argv.filter((a) => !a.startsWith("--skills=")).join(" ");
  return { task, skillsArg };
}

function selectSkills(skillsArg: string | undefined, skills: Skill[], task: string): Skill[] {
  if (!skillsArg) return resolveSkills(task, skills);

  const ids = skillsArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 1 && ids[0] === "all") {
    return skills;
  }

  const byId = new Map(skills.map((s) => [s.id, s]));
  const selected = ids.map((id) => byId.get(id)).filter((s): s is Skill => s !== undefined);
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    console.warn(`Warning: unknown skill id(s): ${missing.join(", ")}`);
  }
  return selected.length > 0 ? selected : resolveSkills(task, skills);
}

async function main(): Promise<void> {
  const config = loadConfig();

  const { task: rawTask, skillsArg } = parseArgs(process.argv.slice(2));
  const task =
    rawTask || "Explain the advantages of TypeScript for building multi-agent systems";

  const skills = await loadSkills(config.skillsDir);
  const selected = selectSkills(skillsArg, skills, task);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "_");
  const runDir = path.join(process.cwd(), "results", stamp);
  await mkdir(path.join(runDir, "autotests"), { recursive: true });
  await writeFile(
    path.join(runDir, "task.md"),
    `Task: ${task}\n\nSkills: ${selected.map((s) => s.id).join(" -> ")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "summary.md"),
    `# Run ${stamp}\n\nTask: ${task}\n\nSkills: ${selected.map((s) => s.id).join(" -> ")}\n`,
    "utf8",
  );

  console.log(`Task: ${task}`);
  console.log(`Skills: ${selected.map((s) => s.id).join(" -> ")}`);
  console.log(`Results dir: ${runDir}`);

  let priorContext = "";
  for (const skill of selected) {
    console.log(`\n========== SKILL: ${skill.name} ==========`);
    const agents = buildAgents(config, skill, runDir);
    const orchestrator = new Orchestrator(agents, config.concurrency);

    const result = await orchestrator.run(task, priorContext);

    console.log("\n=== Subtasks ===\n");
    for (const r of result.subtasks) {
      const status = r.ok ? "OK" : "ERR";
      const firstLine = r.output.split("\n")[0] ?? "";
      console.log(`[${status}] ${r.subtask.title}${r.ok ? "" : ` — ${r.error}`}`);
      if (r.ok && firstLine.trim()) console.log(`        ${firstLine}`);
    }

    console.log("\n=== Final answer ===\n");
    console.log(result.final);
    priorContext = result.final;

    try {
      const skillDir = path.join(runDir, skill.id);
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "final.md"), result.final, "utf8");
      await writeFile(
        path.join(skillDir, "subtasks.md"),
        result.subtasks
          .map(
            (r) =>
              `### ${r.subtask.title} — ${r.ok ? "OK" : `ERROR: ${r.error}`}\n${r.output}`,
          )
          .join("\n\n"),
        "utf8",
      );
      await appendFile(
        path.join(runDir, "summary.md"),
        `\n\n## ${skill.name} (${skill.id})\n\n${result.subtasks
          .map((r) => `- [${r.ok ? "OK" : "ERR"}] ${r.subtask.title}`)
          .join("\n")}\n\n${result.final}`,
        "utf8",
      );
      console.log(`\nSaved: ${skillDir}`);
    } catch (error) {
      console.warn(
        `Warning: failed to save results for skill ${skill.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(`\nAll results saved to: ${runDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
