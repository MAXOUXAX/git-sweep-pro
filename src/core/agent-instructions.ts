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

Use \`gsp\` (git-sweep-pro) for Git cleanup, not \`git branch -D\`, \`git worktree remove\` or \`git push --delete\`: gsp checks that no work would be lost, and \`gsp restore\` can recreate the branches it deletes.

- After merging a pull request: \`gsp post-pr --yes\` from the branch's worktree, or \`gsp post-pr <branch> --yes\` from anywhere else. If it removed the worktree you were in, continue in \`nextCwd\` (with \`--json\`) or the directory it prints.
- Clean the repository: \`gsp clean --json\` to read the plan, then \`gsp clean --yes\`.
- Delete one branch: \`gsp clean <branch> --yes\`. Add \`--force\` only when the person agreed; \`gsp restore\` can bring the branch back.
- Remove a worktree you created (review, scratch): \`gsp worktree remove <path>\`. If it is kept, read why. Add \`--discard-changes\` only when everything listed is yours to throw away: uncommitted changes and ignored files are deleted for good.
- List worktrees: \`gsp worktree list --json\`.
- Remote branches: \`gsp clean --remote\` shows the plan; add \`--yes\` to apply it.
- Undo a branch deletion: \`gsp restore <branch>\` (\`gsp restore origin/<branch>\` for a remote one).

Without a terminal, gsp changes nothing unless \`--yes\` is passed; in a pseudo-terminal, add \`--non-interactive\`. \`--yes\` never forces. With \`--json\`, stdout is one document: whatever gsp kept has a \`reason\` and a \`hint\`, and \`next\` is the command to run next. Run \`gsp sync\` (rebase, then force-push with a lease) only when asked.

| Exit | Meaning |
| --- | --- |
| 0 | Done, or nothing to do |
| 1 | Something failed: read the output |
| 2 | Invalid arguments, or no such branch, remote or worktree |
| 3 | \`gsp sync\` paused on conflicts: resolve and stage them, then \`gsp resume\` |
| 4 | Cancelled at a prompt |
| 5 | Something was kept or needs approval: read \`next\` or the \`hint\`, and ask before adding \`--force\` or \`--discard-changes\` |

Run \`gsp help\` for every command.
${END_MARKER}`;

/**
 * Every note `gsp agents` shipped before this one (1.3.0, 1.3.1, 1.4.0),
 * without its markers. A copy of one, found without markers, is replaced:
 * once whitespace is normalised, it is word for word what gsp wrote. Any
 * other "Git cleanup" section is someone's own text, left in place.
 */
const PAST_NOTES: readonly string[] = [
	'## Git cleanup\n\nUse the `gsp` CLI to clean up the Git workspace. Run `gsp help` to see its commands.',
	[
		'## Git cleanup',
		'',
		'Use the `gsp` CLI to clean up the Git workspace. Run `gsp help` to see its commands.',
		'',
		'Run `gsp list --json` to inspect candidates before deleting. It returns `stale`, `protected`, `checkedOut`, `merged` and `worktrees`; only stale branches outside worktrees are pre-selected. Add `--no-fetch` to inspect local refs without fetching.',
		'',
		'Use `--non-interactive` for agent commands, including in a pseudo-terminal. Confirmations are refused unless `--yes` is passed. Only use `gsp sweep --non-interactive --yes` when deletion is authorized. `--yes` accepts every confirmation, including force-deleting branches Git considers unmerged.',
		'',
		'Use `gsp restore --json` to list recoverable deletions and `gsp restore <branch> --non-interactive` to restore one. `--json` is supported only for listing candidates or recoverable deletions. Parse stdout as JSON only on exit 0; diagnostics go to stderr.',
		'',
		'Exit codes: 0 completed or nothing to do, 1 failed, 2 invalid arguments, 3 sync paused on conflicts, 4 cancelled with `--non-interactive`. On exit 3, resolve the conflicts, stage the resolved files, then run `gsp resume --non-interactive`. `sync` rebases and force-pushes with a lease; `post-pr` switches branches, deletes, sweeps and pulls. Run these only when authorized.',
	].join('\n'),
	[
		'## Git cleanup',
		'',
		'Use the `gsp` CLI to clean up the Git workspace. Run `gsp help` to see its commands.',
		'',
		'Run `gsp list --json` to inspect candidates before deleting. It returns `stale`, `protected`, `checkedOut`, `merged` and `worktrees`; only stale branches outside worktrees are pre-selected. Add `--no-fetch` to inspect local refs without fetching.',
		'',
		'Use `--non-interactive` for agent commands, including in a pseudo-terminal. Confirmations are refused unless `--yes` is passed. Only use `gsp sweep --non-interactive --yes` when deletion is authorized. `--yes` accepts every confirmation, including force-deleting branches Git considers unmerged.',
		'',
		'Use `gsp worktree list --json` to inspect the worktrees and their states; `gsp worktree remove <path|branch> --non-interactive` removes one linked worktree (unlock a locked one first), and `gsp worktree prune` forgets registrations whose directory is gone. Use `gsp restore --json` to list recoverable deletions and `gsp restore <branch> --non-interactive` to restore one. `--json` is supported only for listing candidates, worktrees, or recoverable deletions. Parse stdout as JSON only on exit 0; diagnostics go to stderr.',
		'',
		'Exit codes: 0 completed or nothing to do, 1 failed, 2 invalid arguments, 3 sync paused on conflicts, 4 cancelled with `--non-interactive`. On exit 3, resolve the conflicts, stage the resolved files, then run `gsp resume --non-interactive`. `sync` rebases and force-pushes with a lease; `post-pr` switches branches, deletes, sweeps and pulls. Run these only when authorized.',
	].join('\n'),
];

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

const NORMALIZED_PAST_NOTES = new Set(PAST_NOTES.map(normalize));

/** What adding the block did to a file: `replaced` swaps a copy of a past gsp note for it. */
export type AgentFileChange = 'created' | 'added' | 'updated' | 'replaced' | 'unchanged';

const GSP_MENTION = /\bgsp\b|git-sweep-pro/;

const CLEANUP_HEADING = /^#{1,6}\s+Git cleanup\s*$/i;

/** A span of lines, `[start, end)`. */
type Span = readonly [number, number];

/** The lines of a fenced code block, fences included: examples, never advice to act on. */
function fencedLines(lines: readonly string[]): Set<number> {
	const fenced = new Set<number>();
	let fence: string | undefined;
	lines.forEach((line, index) => {
		const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence === undefined && opening) {
			fence = opening;
			fenced.add(index);
		} else if (fence !== undefined) {
			fenced.add(index);
			if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) {
				fence = undefined;
			}
		}
	});
	return fenced;
}

/** The lines outside code blocks that are exactly `marker`. */
function markerLines(lines: readonly string[], fenced: ReadonlySet<number>, marker: string): number[] {
	return lines.flatMap((line, index) => (line.trim() === marker && !fenced.has(index) ? [index] : []));
}

/** The "Git cleanup" sections outside code blocks: each heading up to the next heading of the same level or above, trailing blank lines left out. */
function cleanupSections(lines: readonly string[], fenced: ReadonlySet<number>): Span[] {
	return lines.flatMap((line, start): Span[] => {
		if (fenced.has(start) || !CLEANUP_HEADING.test(line)) {
			return [];
		}
		const level = /^#+/.exec(line)?.[0].length ?? 1;
		let end = start + 1;
		while (end < lines.length && !(!fenced.has(end) && /^(#{1,6})\s/.exec(lines[end]) && (/^#+/.exec(lines[end])?.[0].length ?? 7) <= level)) {
			end++;
		}
		while (end > start + 1 && lines[end - 1].trim() === '') {
			end--;
		}
		return [[start, end]];
	});
}

/**
 * True when the whole `section` is a past gsp note, word for word. One with
 * a paragraph of someone's own added is not: replacing only the note would
 * leave that paragraph under another heading.
 */
const isPastNote = (lines: readonly string[], section: Span) => NORMALIZED_PAST_NOTES.has(normalize(lines.slice(...section).join('\n')));

/** Where the gsp notes of a file are. */
type NoteLayout = {
	/** The marked block, when its markers are balanced. */
	readonly marked: Span | undefined;
	/** The markers are there, but not as one start followed by one end. */
	readonly unbalanced: boolean;
	/** Copies of a past note, without markers. */
	readonly past: readonly Span[];
	/** Other "Git cleanup" sections that mention gsp: someone's own text, maybe an edited note. */
	readonly others: readonly Span[];
};

function layoutOf(lines: readonly string[]): NoteLayout {
	const fenced = fencedLines(lines);
	const starts = markerLines(lines, fenced, START_MARKER);
	const ends = markerLines(lines, fenced, END_MARKER);
	const balanced = starts.length === 1 && ends.length === 1 && ends[0] > starts[0];
	const marked: Span | undefined = balanced ? [starts[0], ends[0] + 1] : undefined;
	const inMarked = (index: number) => marked !== undefined && index >= marked[0] && index < marked[1];
	const sections = cleanupSections(lines, fenced).filter(([start]) => !inMarked(start));
	const past: Span[] = [];
	const others: Span[] = [];
	for (const section of sections) {
		if (isPastNote(lines, section)) {
			past.push(section);
		} else if (lines.slice(...section).some((line) => GSP_MENTION.test(line))) {
			others.push(section);
		}
	}
	return { marked, unbalanced: (starts.length > 0 || ends.length > 0) && !balanced, past, others };
}

/** The line ending most lines of `content` use. */
function dominantEol(content: string): '\r\n' | '\n' {
	const crlf = content.split('\r\n').length - 1;
	const lf = content.split('\n').length - 1 - crlf;
	return crlf > lf ? '\r\n' : '\n';
}

/** What {@link planAgentBlock} would write. */
export type AgentBlockPlan = {
	readonly content: string;
	readonly change: Exclude<AgentFileChange, 'created'>;
	/** 1-based lines, in the content written, of older "Git cleanup" sections left in place, for the person to review. */
	readonly review: readonly number[];
};

/**
 * `content` with the gsp block: replaced in place when the file already has
 * one; otherwise in place of the first copy of a past gsp note; appended
 * after a blank line when it has neither. Any other "Git cleanup" section is
 * left in place and reported in `review`. Each line keeps its own ending;
 * the block takes the file's dominant one. Throws rather than guess when the
 * markers are unbalanced.
 */
export function planAgentBlock(content: string): AgentBlockPlan {
	const eol = dominantEol(content);
	// Each line with its own ending, so that splicing leaves the others untouched.
	const raw = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const lines = raw.map((line) => line.replace(/\r?\n$/, ''));
	const layout = layoutOf(lines);
	if (layout.unbalanced) {
		// Replacing a guessed span could delete the user's own instructions.
		throw new Error('its gsp markers are unbalanced. Remove them, then run gsp agents again.');
	}
	const target = layout.marked ?? layout.past[0];
	// Lines of the file once written: those after the block shift by the lines it adds.
	const shift = target ? AGENT_BLOCK.split('\n').length - (target[1] - target[0]) : 0;
	const review = [...(layout.marked ? layout.past : layout.past.slice(1)), ...layout.others]
		.map(([start]) => (target && start > target[0] ? start + shift : start) + 1)
		.sort((a, b) => a - b);
	const block = AGENT_BLOCK.replace(/\n/g, eol);
	if (!target) {
		const separator = content.length === 0 ? '' : content.endsWith('\n') ? eol : eol + eol;
		return { content: content + separator + block + eol, change: 'added', review };
	}
	const [start, end] = target;
	// The last line replaced keeps its line ending, or has none at the end of the file.
	const ending = /\r?\n$/.exec(raw[end - 1])?.[0] ?? '';
	const updated = [...raw.slice(0, start), block + ending, ...raw.slice(end)].join('');
	const change = updated === content ? 'unchanged' : layout.marked ? 'updated' : 'replaced';
	return { content: updated, change, review };
}

/** `content` with the gsp block (see {@link planAgentBlock}). */
export function upsertAgentBlock(content: string): string {
	return planAgentBlock(content).content;
}

/** Advice that contradicts gsp, found by {@link checkAgentAdvice}. */
export type AdviceRule =
	| 'outdated-note'
	| 'raw-branch-delete'
	| 'raw-worktree-remove'
	| 'raw-push-delete'
	| 'no-worktree-command'
	| 'old-list-json'
	| 'merged-flag'
	| 'yes-forces'
	| 'post-pr-default'
	| 'worktree-remove-force';

export type AdviceFinding = {
	/** As given on the command line, or the instruction file's name. */
	readonly file: string;
	/** 1-based. */
	readonly line: number;
	readonly text: string;
	readonly rule: AdviceRule;
	readonly suggestion: string;
};

/** Words that warn against a command rather than recommend it. */
const PROHIBITION = /\b(don't|do not|never|avoid|instead of|rather than)\b/i;

/**
 * The clause of `text` around `[from, to)`: up to the sentence or clause
 * breaks on either side, so that "use gsp; for one branch, run git branch -D"
 * is judged on its second half.
 */
function clauseAround(text: string, from: number, to: number): string {
	const breaks = /[.;!?](?=\s)|\s[—–]\s|,\s(?:but|then|or)\s/g;
	let start = 0;
	let end = text.length;
	for (let match = breaks.exec(text); match; match = breaks.exec(text)) {
		if (match.index + match[0].length <= from) {
			start = match.index + match[0].length;
		} else if (match.index >= to) {
			end = match.index;
			break;
		}
	}
	return text.slice(start, end);
}

type AdviceRuleSpec = {
	readonly rule: AdviceRule;
	readonly pattern: RegExp;
	/** Also flags a line this matches. */
	readonly also?: (text: string) => boolean;
	/** Recommends a raw Git command: only flagged in a clause that neither names gsp nor warns against it. */
	readonly rawGit?: boolean;
	readonly suggestion: string;
};

const ADVICE_RULES: readonly AdviceRuleSpec[] = [
	{
		rule: 'raw-branch-delete',
		pattern: /\bgit branch\b[^\n`]*\s(-D|-d|--delete)\b/,
		rawGit: true,
		suggestion: '`gsp clean <branch> --yes`; add `--force` only when the person agreed: `gsp restore` can bring the branch back.',
	},
	{
		rule: 'raw-worktree-remove',
		pattern: /\bgit worktree remove\b/,
		rawGit: true,
		suggestion: '`gsp worktree remove <path>`; if it is kept, read why, and add `--discard-changes` only when what it lists is yours to throw away.',
	},
	{
		rule: 'raw-push-delete',
		pattern: /\bgit push\b[^\n`]*(--delete\b|\s-d\s|\s:[\w./-]+)/,
		rawGit: true,
		suggestion: '`gsp clean --remote` to read the plan, then `gsp clean --remote --yes`.',
	},
	{
		rule: 'worktree-remove-force',
		pattern: /\bgsp worktree remove\b[^\n]*\s(--force|-f)\b/,
		suggestion: '`gsp worktree remove <path> --discard-changes`: since 2.0, `--force` only lifts the proof that a branch is merged, and `gsp worktree remove` rejects it.',
	},
	{
		rule: 'post-pr-default',
		pattern: /\bgsp post-pr\s+(main|master|trunk|develop)\b/,
		suggestion: '`gsp post-pr --yes` from the merged branch\'s worktree, or `gsp post-pr <branch> --yes`: the branch named is the one to finish, not the one to go back to.',
	},
	{
		rule: 'no-worktree-command',
		pattern: /\bgsp\b[^.\n]{0,30}\b(has no|doesn't have|does not have|lacks|cannot|can't|can not|doesn't support|does not support)\b[^.\n]{0,30}\bworktrees?\b/i,
		suggestion: 'gsp has worktree commands: `gsp worktree list --json`, `gsp worktree remove <path>`, `gsp worktree prune`.',
	},
	{
		rule: 'old-list-json',
		// The fields of the 1.x listing, in backticks or next to the command that printed them.
		pattern: /`(checkedOut|stale)`/,
		also: (text) => /\bgsp (list|sweep)\b[^\n]*--json\b/.test(text) && /\b(checkedOut|stale)\b/.test(text),
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

/** True when `spec` flags `text`. */
function flags(spec: AdviceRuleSpec, text: string): boolean {
	const match = spec.pattern.exec(text);
	if (!match) {
		return spec.also?.(text) ?? false;
	}
	if (!spec.rawGit) {
		return true;
	}
	// A clause that names gsp describes it, or warns against raw Git: not the advice this looks for.
	const clause = clauseAround(text, match.index, match.index + match[0].length);
	return !PROHIBITION.test(clause) && !GSP_MENTION.test(clause);
}

/**
 * Lines of `content` that tell an agent to do what gsp does with raw Git,
 * or describe gsp as it no longer is. Code blocks and the current gsp block
 * are skipped. An outdated marked block, or a copy of a past note, is
 * reported once, as `gsp agents` replaces it; another copy, or a "Git
 * cleanup" section of someone's own that mentions gsp, is reported for review,
 * as `gsp agents` leaves it in place. `writable` tells whether `gsp agents`
 * can rewrite `file` (an instruction file at the repository's root), to
 * suggest it. Read-only and heuristic.
 */
export function checkAgentAdvice(file: string, content: string, writable: boolean): AdviceFinding[] {
	const lines = content.split(/\r?\n/);
	const fenced = fencedLines(lines);
	const findings: AdviceFinding[] = [];
	const skipped = new Set<number>(fenced);
	const note = (span: Span, suggestion: string, skip: boolean) => {
		const [from, to] = span;
		// Shown by its heading rather than its marker.
		const shown = lines[from].trim() === START_MARKER && from + 1 < to ? from + 1 : from;
		findings.push({ file, line: shown + 1, text: lines[shown], rule: 'outdated-note', suggestion });
		for (let index = from; skip && index < to; index++) {
			skipped.add(index);
		}
	};
	const replace = writable
		? `Run \`gsp agents ${path.basename(file)}\` to replace this gsp note with the current one.`
		: 'Replace this gsp note with the current one, from the "For coding agents" section of the gsp README.';
	const layout = layoutOf(lines);
	const { marked } = layout;
	if (marked && lines.slice(...marked).map((line) => line.trimEnd()).join('\n') === AGENT_BLOCK) {
		for (let index = marked[0]; index < marked[1]; index++) {
			skipped.add(index);
		}
	} else if (marked) {
		note(marked, replace, true);
	}
	layout.past.forEach((span, index) =>
		note(span, index === 0 && !marked ? replace : 'Remove this older copy of the gsp note: the current one covers it, and `gsp agents` replaces only one.', true)
	);
	for (const span of layout.others) {
		note(span, 'Review this section: it looks like an older gsp note, edited since. `gsp agents` leaves it in place; keep what is yours and remove what the gsp note covers.', false);
	}
	lines.forEach((text, index) => {
		if (skipped.has(index)) {
			return;
		}
		const rule = ADVICE_RULES.find((candidate) => flags(candidate, text));
		if (rule) {
			findings.push({ file, line: index + 1, text, rule: rule.rule, suggestion: rule.suggestion });
		}
	});
	return findings.sort((a, b) => a.line - b.line);
}

/** True when `target` is `root` or inside it. */
function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The file to edit for `file`, and whether it exists yet. A symbolic link
 * is followed only within the repository (e.g. CLAUDE.md linked to
 * AGENTS.md): gsp never writes outside it. A link to a file that does not
 * exist yet creates that file, when it would be in the repository.
 */
function resolveAgentFile(root: string, file: AgentFile): { readonly path: string; readonly exists: boolean } {
	const filePath = path.join(root, file);
	const link = fs.lstatSync(filePath, { throwIfNoEntry: false });
	if (!link) {
		return { path: filePath, exists: false };
	}
	const realRoot = fs.realpathSync(root);
	if (link.isSymbolicLink() && !fs.existsSync(filePath)) {
		const linked = path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
		const folder = path.dirname(linked);
		const parent = fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() ? fs.realpathSync(folder) : undefined;
		if (!parent) {
			throw new Error(`it links to ${linked}, whose folder does not exist. Create it, or replace the link with a file.`);
		}
		const target = path.join(parent, path.basename(linked));
		if (!isWithin(realRoot, target)) {
			throw new Error(`it links to ${linked}, which does not exist and is outside the repository. Replace the link with a file.`);
		}
		// Writing would follow that link too, wherever it points.
		if (fs.lstatSync(target, { throwIfNoEntry: false })) {
			throw new Error(`it links to ${linked}, another link to a file that does not exist. Replace the link with a file.`);
		}
		return { path: target, exists: false };
	}
	const target = fs.realpathSync(filePath);
	if (!isWithin(realRoot, target)) {
		throw new Error(`it links to ${target}, outside the repository.`);
	}
	if (!fs.statSync(target).isFile()) {
		throw new Error('it is not a file.');
	}
	return { path: target, exists: true };
}

/** What {@link writeAgentBlock} did, and the older sections it left for the person to review. */
export type AgentFileWrite = { readonly change: AgentFileChange; readonly review: readonly number[] };

/** Adds the gsp block to `file` in `root`, creating the file if needed. */
export function writeAgentBlock(root: string, file: AgentFile): AgentFileWrite {
	const target = resolveAgentFile(root, file);
	const content = target.exists ? fs.readFileSync(target.path, 'utf8') : '';
	const plan = planAgentBlock(content);
	if (plan.change !== 'unchanged') {
		// A new file is created only where nothing is, not even a link put there since.
		fs.writeFileSync(target.path, plan.content, { flag: target.exists ? 'w' : 'wx' });
	}
	return { change: target.exists ? plan.change : 'created', review: plan.review };
}

const CHANGE_MESSAGES: Record<AgentFileChange, (file: AgentFile) => string> = {
	created: (file) => `Created ${file} with the gsp instructions.`,
	added: (file) => `Added the gsp instructions to ${file}.`,
	updated: (file) => `Updated the gsp instructions in ${file}.`,
	replaced: (file) => `Replaced the older gsp note in ${file} with the current instructions.`,
	unchanged: (file) => `${file} already has the gsp instructions.`,
};

/** The older sections left in `file`, for the person to review, or nothing. */
function describeReview(file: AgentFile, review: readonly number[]): string {
	if (review.length === 0) {
		return '';
	}
	const where = review.length === 1 ? `line ${review[0]}` : `lines ${review.slice(0, -1).join(', ')} and ${review.at(-1)}`;
	const them = review.length === 1 ? 'it' : 'them';
	return ` ${file} still has an older "Git cleanup" section at ${where}, left as it is: review ${them}, and remove what the gsp instructions now cover.`;
}

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
			const { change, review } = writeAgentBlock(root, file);
			messages.push(CHANGE_MESSAGES[change](file) + describeReview(file, review));
		} catch (error) {
			ui.showErrorMessage(`Unable to write ${file}: ${toErrorMessage(error)}`);
			return 'failed';
		}
	}
	ui.showInformationMessage(messages.join(' '));
	return 'ok';
}
