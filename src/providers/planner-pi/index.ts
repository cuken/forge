import type { WorkstreamDraft, WorkstreamPlan, WorkstreamPlannerProvider, WorkstreamPlanRequest } from '../../core/workstream.js';
import type { Task } from '../../core/types.js';
import { runCommand } from '../../util/command.js';

const complexities: Task['complexity'][] = ['trivial', 'small', 'medium', 'large'];

// Agents wrap JSON in prose; take the first balanced block starting at the opener.
export function extractJsonBlock(text: string, opener: '[' | '{'): string | null {
  const closer = opener === '[' ? ']' : '}';
  const start = text.indexOf(opener);
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export class PiWorkstreamPlannerProvider implements WorkstreamPlannerProvider {
  id = 'workstream-planner.pi';
  kind = 'workstream-planner' as const;
  constructor(private command = 'pi', private args: string[] = ['-p'], private maxQuestions = 4) {}

  async planWorkstream(input: WorkstreamPlanRequest): Promise<WorkstreamPlan> {
    const clarifications: { question: string; answer: string }[] = [];
    if (input.ask) {
      for (const question of await this.clarifyingQuestions(input)) {
        clarifications.push({ question, answer: await input.ask(question) });
      }
    }
    return this.draftPlan(input, clarifications);
  }

  private async runPi(prompt: string): Promise<string> {
    const result = await runCommand(this.command, [...this.args, prompt]);
    if (result.exitCode !== 0) throw new Error(`${this.command} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  }

  private preamble(input: WorkstreamPlanRequest): string {
    return `You are a roadmap planning assistant for Forge, a provider-neutral orchestrator that turns work items into isolated agent-executed tasks.\n\nGoal: ${input.prompt}\n${input.context ? `\nProject context:\n${input.context}\n` : ''}`;
  }

  private async clarifyingQuestions(input: WorkstreamPlanRequest): Promise<string[]> {
    const prompt = `${this.preamble(input)}\nList only the clarifying questions whose answers would change how this goal is broken into tasks (scope edges, sequencing, hard constraints). Be selective: skip anything answerable from the goal or context, and ask at most ${this.maxQuestions}. Keep each question short and concrete.\n\nRespond with ONLY a JSON array of question strings. Respond with [] if the goal is unambiguous.`;
    const block = extractJsonBlock(await this.runPi(prompt), '[');
    if (!block) return [];
    try {
      const parsed: unknown = JSON.parse(block);
      return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === 'string' && !!q.trim()).slice(0, this.maxQuestions) : [];
    } catch {
      return [];
    }
  }

  private async draftPlan(input: WorkstreamPlanRequest, clarifications: { question: string; answer: string }[]): Promise<WorkstreamPlan> {
    const qa = clarifications.length ? `\nClarifications from the user:\n${clarifications.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join('\n')}\n` : '';
    const prompt = `${this.preamble(input)}${qa}\nBreak the goal into an ordered workstream of tasks. Rules:\n- Each item must be independently executable by a coding agent with no other context: an imperative title and a 1-3 sentence description stating intent, boundaries, and what done means.\n- complexity is one of trivial|small|medium|large. medium and large stop for human spec approval, so size honestly rather than optimistically.\n- dependencies lists the ids of items that must be finished first; leave it empty when work can safely run in parallel.\n- Slice vertically (each item shippable, tested, and documented on its own), not by architectural layer.\n\nRespond with ONLY JSON in this shape:\n{"summary": "one-sentence plan summary", "items": [{"id": "kebab-case-slug", "title": "...", "description": "...", "complexity": "small", "dependencies": []}]}`;
    const output = await this.runPi(prompt);
    const block = extractJsonBlock(output, '{');
    if (!block) throw new Error(`Planner returned no JSON plan: ${output.trim().slice(0, 200)}`);
    const parsed = JSON.parse(block) as { summary?: unknown; items?: unknown };
    if (!Array.isArray(parsed.items) || !parsed.items.length) throw new Error('Planner returned a plan with no items');
    const items = parsed.items.map((raw, index) => this.normalizeDraft(raw as Record<string, unknown>, index));
    return { providerId: this.id, summary: typeof parsed.summary === 'string' ? parsed.summary : undefined, items };
  }

  private normalizeDraft(raw: Record<string, unknown>, index: number): WorkstreamDraft {
    if (typeof raw.title !== 'string' || !raw.title.trim()) throw new Error(`Planner item ${index + 1} is missing a title`);
    return {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined,
      title: raw.title.trim(),
      description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined,
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.filter((dep): dep is string => typeof dep === 'string') : [],
      complexity: typeof raw.complexity === 'string' && complexities.includes(raw.complexity as Task['complexity']) ? raw.complexity as Task['complexity'] : 'small',
    };
  }
}
