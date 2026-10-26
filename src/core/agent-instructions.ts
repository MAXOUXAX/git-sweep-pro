import * as fs from 'node:fs';
import * as path from 'node:path';
import { toErrorMessage } from './errors';
import type { WorkflowContext, WorkflowOutcome } from './workflow';

/** The instruction files coding agents read, and who reads each. */
export const AGENT_FILES = {
	'AGENTS.md': 'Codex, Cursor, GitHub Copilot, OpenCode',
	'CLAUDE.md': 'Claude Code',
} as const;

export type AgentFile = keyof typeof AGENT_FILES;

export const AGENT_FILE_NAMES = Object.keys(AGENT_FILES) as AgentFile[];

export function isAgentFile(name: string): name is AgentFile {
	return Object.hasOwn(AGENT_FILES, name);
}

// HTML comments, as Next.js does: invisible once rendered, and they let a
// rerun find and replace its own block without touching the rest of the file.
const START_MARKER = '<!-- BEGIN:git-sweep-pro -->';
const END_MARKER = '<!-- END:git-sweep-pro -->';

export const AGENT_BLOCK = `${START_MARKER}
## Git cleanup

Use \`gsp\` (git-sweep-pro) for Git cleanup. Don't use \`git branch -D\`, \`git worktree remove\` or \`git push --delete\`: gsp checks the work is safe and records deletions for \`gsp restore\`.

- After merging a pull request: \`gsp post-pr --yes\` from the branch's worktree, or \`gsp post-pr <branch> --yes\` from the main checkout. If it removed the worktree you were in, continue in \`nextCwd\` (with \`--json\`) or the directory it prints.
- Clean the repository: \`gsp clean --json\` to read the plan, then \`gsp clean --yes\` to apply it.
- Delete one branch: \`gsp clean <branch> --yes\`. Add \`--force\` only when the person agreed to lose its unpushed work.
- Remove a scratch or review worktree: \`gsp worktree remove <path>\`. Add \`--force\` when it holds uncommitted work you can throw away.
- List worktrees: \`gsp worktree list --json\`.
- Remote branches: \`gsp clean --remote\` shows the plan; add \`--yes\` to apply it.
- Undo a deletion: \`gsp restore <branch>\`.

Without a terminal, gsp changes nothing unless \`--yes\` is passed; in a pseudo-terminal, add \`--non-interactive\`. \`--yes\` never forces: it deletes only branches whose work exists elsewhere. With \`--json\`, stdout is one document: each skipped branch has a \`reason\` and a \`hint\`, and \`next\` is the command to run next. Run \`gsp sync\` (rebase, then force-push with a lease) only when asked.

| Exit | Meaning |
| --- | --- |
| 0 | Done, or nothing to do |
| 1 | Something failed: read the output |
| 2 | Invalid arguments, or no such branch, remote or worktree |
| 3 | \`gsp sync\` paused on conflicts: resolve and stage them, then \`gsp resume\` |
| 4 | Cancelled at a prompt |
| 5 | Not everything was done: more needs approval (\`--yes\`, \`--force\`), or post-pr or worktree remove kept something. Read \`next\` or the hint |

Run \`gsp help\` for every command, and \`gsp agents --check\` to find outdated advice in these files.
${END_MARKER}`;

/** What adding the block did to a file: `replaced` swaps an older, unmarked gsp note for it. */
export type AgentFileChange = 'created' | 'added' | 'updated' | 'replaced' | 'unchanged';

const GSP_MENTION = /\bgsp\b|git-sweep-pro/;

/**
 * The lines `[start, end)` of an older gsp note without markers: a
 * "Git cleanup" heading followed by paragraphs that all mention gsp, as
 * every note before 2.0 was, whether gsp wrote it or someone copied it. Stops
 * at the first paragraph that doesn't, so a person's own text stays.
 */
function findUnmarkedNote(lines: readonly string[]): [number, number] | undefined {
	const start = lines.findIndex((line) => /^#{1,6}\s+Git cleanup\s*$/i.test(line));
	if (start < 0) {
		return undefined;
	}
	let end = start + 1;
	let cursor = start + 1;
	while (cursor < lines.length) {
		while (cursor < lines.length && lines[cursor].trim() === '') {
			cursor++;
		}
		let paragraphEnd = cursor;
		while (paragraphEnd < lines.length && lines[paragraphEnd].trim() !== '' && !/^#{1,6}\s/.test(lines[paragraphEnd])) {
			paragraphEnd++;
		}
		const paragraph = lines.slice(cursor, paragraphEnd);
		if (paragraph.length === 0 || !paragraph.every((line) => GSP_MENTION.test(line))) {
			break;
		}
		end = paragraphEnd;
		cursor = paragraphEnd;
	}
	return end > start + 1 ? [start, end] : undefined;
}

/**
 * `content` with the gsp block: replaced in place when the file already has
 * one, or an older note without markers; appended after a blank line
 * otherwise. Keeps the file's line endings, and throws rather than guess
 * when the markers are unbalanced.
 */
export function upsertAgentBlock(content: string): string {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const block = AGENT_BLOCK.replace(/\n/g, eol);
	const starts = content.split(START_MARKER).length - 1;
	const ends = content.split(END_MARKER).length - 1;
	if (starts === 0 && ends === 0) {
		const lines = content.split(eol);
		const unmarked = findUnmarkedNote(lines);
		if (unmarked) {
			return [...lines.slice(0, unmarked[0]), ...block.split(eol), ...lines.slice(unmarked[1])].join(eol);
		}
		const separator = content.length === 0 ? '' : content.endsWith(eol) ? eol : eol + eol;
		return content + separator + block + eol;
	}
	const start = content.indexOf(START_MARKER);
	const end = content.indexOf(END_MARKER);
	// Anything but one start marker followed by one end marker is ambiguous:
	// replacing a guessed span could delete the user's own instructions.
	if (starts !== 1 || ends !== 1 || end < start) {
		throw new Error('its gsp markers are unbalanced. Remove them, then run gsp agents again.');
	}
	return content.slice(0, start) + block + content.slice(end + END_MARKER.length);
}

/** Advice that contradicts gsp, found by {@link checkAgentAdvice}. */
export type AdviceRule = 'outdated-note' | 'raw-branch-delete' | 'raw-worktree-remove' | 'raw-push-delete' | 'no-worktree-command' | 'old-list-json' | 'merged-flag' | 'yes-forces';

export type AdviceFinding = {
	/** As given on the command line, or the instruction file's name. */
	readonly file: string;
	/** 1-based. */
	readonly line: number;
	readonly text: string;
	readonly rule: AdviceRule;
	readonly suggestion: string;
};

/** A line that warns against a command rather than recommending it. */
const PROHIBITION = /\b(don't|do not|never|avoid|instead of|rather than)\b/i;

const ADVICE_RULES: readonly { readonly rule: AdviceRule; readonly pattern: RegExp; /** Recommends a raw Git command: only flagged on a line that neither names gsp nor warns against it. */
	readonly rawGit?: boolean; readonly suggestion: string }[] = [
	{
		rule: 'raw-branch-delete',
		pattern: /\bgit branch\b[^\n`]*\s(-D|-d|--delete)\b/,
		rawGit: true,
		suggestion: '`gsp clean <branch> --yes`; add `--force` only when the person agreed to lose unpushed work.',
	},
	{
		rule: 'raw-worktree-remove',
		pattern: /\bgit worktree remove\b/,
		rawGit: true,
		suggestion: '`gsp worktree remove <path>`; add `--force` when it holds uncommitted work you can throw away.',
	},
	{
		rule: 'raw-push-delete',
		pattern: /\bgit push\b[^\n`]*(--delete\b|\s-d\s|\s:[\w./-]+)/,
		rawGit: true,
		suggestion: '`gsp clean --remote` to read the plan, then `gsp clean --remote --yes`.',
	},
	{
		rule: 'no-worktree-command',
		pattern: /\bgsp\b[^.\n]{0,30}\b(has no|doesn't have|does not have|lacks|cannot|can't|can not|doesn't support|does not support)\b[^.\n]{0,30}\bworktrees?\b/i,
		suggestion: 'gsp has worktree commands: `gsp worktree list --json`, `gsp worktree remove <path>`, `gsp worktree prune`.',
	},
	{
		rule: 'old-list-json',
		// The fields of the 1.x listing.
		pattern: /`(checkedOut|stale)`/,
		suggestion: '`gsp clean --json`: each branch has an `action`, a `reason` and a `hint`, and `next` is the command to run next.',
	},
	{
		rule: 'merged-flag',
		pattern: /--merged\b/,
		suggestion: '`gsp clean --json`: gsp also finds squash- and rebase-merged branches, which `--merged` misses.',
	},
	{
		rule: 'yes-forces',
		pattern: /--yes\b[^\n]*force[- ]delet|force[- ]delet[^\n]*--yes\b/i,
		suggestion: '`--yes` never forces: it deletes only branches whose work exists elsewhere. Branches with unpushed work need `--force`.',
	},
];

/**
 * Lines of `content` that tell an agent to do what gsp does with raw Git,
 * or describe gsp as it no longer is. The current gsp block is skipped; an
 * outdated one, marked or not, is reported once, as `gsp agents` replaces it.
 * `writable` tells whether `gsp agents` can rewrite `file` (an instruction
 * file at the repository's root), to suggest it. Read-only and heuristic.
 */
export function checkAgentAdvice(file: string, content: string, writable: boolean): AdviceFinding[] {
	const lines = content.split(/\r?\n/);
	const findings: AdviceFinding[] = [];
	const skipped = new Set<number>();
	const outdated = (from: number, to: number) => {
		// Shown by its heading rather than its marker.
		const shown = lines[from] === START_MARKER && from + 1 < to ? from + 1 : from;
		findings.push({ file, line: shown + 1, text: lines[shown], rule: 'outdated-note', suggestion: writable
				? `Run \`gsp agents ${path.basename(file)}\` to replace this gsp note with the current one.`
				: 'Replace this gsp note with the current one, from the "For coding agents" section of the gsp README.',
		});
		for (let index = from; index < to; index++) {
			skipped.add(index);
		}
	};
	const start = lines.indexOf(START_MARKER);
	const end = lines.indexOf(END_MARKER);
	if (start >= 0 && end > start) {
		const current = lines.slice(start, end + 1).join('\n') === AGENT_BLOCK;
		if (current) {
			for (let index = start; index <= end; index++) {
				skipped.add(index);
			}
		} else {
			outdated(start, end + 1);
		}
	} else {
		const unmarked = findUnmarkedNote(lines);
		if (unmarked) {
			outdated(...unmarked);
		}
	}
	lines.forEach((text, index) => {
		if (skipped.has(index)) {
			return;
		}
		// A line that names gsp describes it, or warns against raw Git: not the advice this looks for.
		const rawAdvice = !PROHIBITION.test(text) && !GSP_MENTION.test(text);
		const rule = ADVICE_RULES.find((candidate) => candidate.pattern.test(text) && (!candidate.rawGit || rawAdvice));
		if (rule) {
			findings.push({ file, line: index + 1, text, rule: rule.rule, suggestion: rule.suggestion });
		}
	});
	return findings.sort((a, b) => a.line - b.line);
}

/**
 * The file to edit for `file`, or `undefined` when it does not exist yet. A
 * symbolic link is followed only within the repository (e.g. CLAUDE.md
 * linked to AGENTS.md): gsp never writes outside it.
 */
function resolveAgentFile(root: string, file: AgentFile): string | undefined {
	const filePath = path.join(root, file);
	if (!fs.lstatSync(filePath, { throwIfNoEntry: false })) {
		return undefined;
	}
	const target = fs.realpathSync(filePath);
	const relative = path.relative(fs.realpathSync(root), target);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`it links to ${target}, outside the repository.`);
	}
	if (!fs.statSync(target).isFile()) {
		throw new Error('it is not a file.');
	}
	return target;
}

/** Adds the gsp block to `file` in `root`, creating the file if needed. */
export function writeAgentBlock(root: string, file: AgentFile): AgentFileChange {
	const target = resolveAgentFile(root, file);
	const content = target === undefined ? undefined : fs.readFileSync(target, 'utf8');
	const updated = upsertAgentBlock(content ?? '');
	if (updated === content) {
		return 'unchanged';
	}
	fs.writeFileSync(target ?? path.join(root, file), updated);
	if (content === undefined) {
		return 'created';
	}
	if (content.includes(START_MARKER)) {
		return 'updated';
	}
	return findUnmarkedNote(content.split(/\r?\n/)) ? 'replaced' : 'added';
}

const CHANGE_MESSAGES: Record<AgentFileChange, (file: AgentFile) => string> = {
	created: (file) => `Created ${file} with the gsp instructions.`,
	added: (file) => `Added the gsp instructions to ${file}.`,
	updated: (file) => `Updated the gsp instructions in ${file}.`,
	replaced: (file) => `Replaced the older gsp note in ${file} with the current instructions.`,
	unchanged: (file) => `${file} already has the gsp instructions.`,
};

/**
 * Tells coding agents to use gsp: adds a short, delimited block to the
 * instruction files `requested`, or to the ones the user picks (the files
 * that already exist, or AGENTS.md, are pre-selected).
 */
export async function runAgentsWorkflow(context: WorkflowContext, requested: readonly AgentFile[]): Promise<WorkflowOutcome> {
	const { root, ui } = context;
	let files = requested;
	if (files.length === 0) {
		const existing = AGENT_FILE_NAMES.filter((file) => fs.existsSync(path.join(root, file)));
		const preselected = existing.length > 0 ? existing : ['AGENTS.md'];
		const picked = await ui.pickMany({
			items: AGENT_FILE_NAMES.map((file) => ({ label: file, description: AGENT_FILES[file], picked: preselected.includes(file) })),
			title: 'Select files to add the gsp instructions to',
		});
		files = AGENT_FILE_NAMES.filter((file) => picked?.includes(file));
		if (files.length === 0) {
			ui.showInformationMessage('No files selected.');
			return 'cancelled';
		}
	}

	const messages: string[] = [];
	for (const file of new Set(files)) {
		try {
			messages.push(CHANGE_MESSAGES[writeAgentBlock(root, file)](file));
		} catch (error) {
			ui.showErrorMessage(`Unable to write ${file}: ${toErrorMessage(error)}`);
			return 'failed';
		}
	}
	ui.showInformationMessage(messages.join(' '));
	return 'ok';
}
