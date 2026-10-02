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

Use the \`gsp\` CLI to clean up the Git workspace. Run \`gsp help\` to see its commands.

Run \`gsp list --json\` to inspect candidates before deleting. It returns \`stale\`, \`protected\`, \`checkedOut\`, \`merged\` and \`worktrees\`; only stale branches outside worktrees are pre-selected. Add \`--no-fetch\` to inspect local refs without fetching.

Use \`--non-interactive\` for agent commands, including in a pseudo-terminal. Confirmations are refused unless \`--yes\` is passed. Only use \`gsp sweep --non-interactive --yes\` when deletion is authorized. \`--yes\` accepts every confirmation, including force-deleting branches Git considers unmerged.

Use \`gsp restore --json\` to list recoverable deletions and \`gsp restore <branch> --non-interactive\` to restore one. \`--json\` is supported only for listing candidates or recoverable deletions. Parse stdout as JSON only on exit 0; diagnostics go to stderr.

Exit codes: 0 completed or nothing to do, 1 failed, 2 invalid arguments, 3 sync paused on conflicts, 4 cancelled with \`--non-interactive\`. On exit 3, resolve the conflicts, stage the resolved files, then run \`gsp resume --non-interactive\`. \`sync\` rebases and force-pushes with a lease; \`post-pr\` switches branches, deletes, sweeps and pulls. Run these only when authorized.
${END_MARKER}`;

/** What adding the block did to a file. */
export type AgentFileChange = 'created' | 'added' | 'updated' | 'unchanged';

/**
 * `content` with the gsp block: replaced in place when the file already has
 * one, appended after a blank line otherwise. Keeps the file's line endings,
 * and throws rather than guess when the markers are unbalanced.
 */
export function upsertAgentBlock(content: string): string {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const block = AGENT_BLOCK.replace(/\n/g, eol);
	const starts = content.split(START_MARKER).length - 1;
	const ends = content.split(END_MARKER).length - 1;
	if (starts === 0 && ends === 0) {
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
	return content === undefined ? 'created' : content.includes(START_MARKER) ? 'updated' : 'added';
}

const CHANGE_MESSAGES: Record<AgentFileChange, (file: AgentFile) => string> = {
	created: (file) => `Created ${file} with the gsp instructions.`,
	added: (file) => `Added the gsp instructions to ${file}.`,
	updated: (file) => `Updated the gsp instructions in ${file}.`,
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
