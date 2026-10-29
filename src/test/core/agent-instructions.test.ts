import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_BLOCK, checkAgentAdvice, planAgentBlock, runAgentsWorkflow, upsertAgentBlock } from '../../core/agent-instructions';
import { createFakeContext } from '../fake-context';

/** The note `gsp agents` writes. Any change to it is a change to what every agent reads: review it here. */
const NOTE = `<!-- BEGIN:git-sweep-pro -->
## Git cleanup

Use \`gsp\` (git-sweep-pro) for Git cleanup, not \`git branch -D\`, \`git worktree remove\` or \`git push --delete\`: gsp checks that no work would be lost, and \`gsp restore\` can recreate the branches it deletes.

- After merging a pull request: \`gsp post-pr --yes\` from the branch's worktree, or \`gsp post-pr <branch> --yes\` from anywhere else. If it removed the worktree you were in, continue in \`nextCwd\` (with \`--json\`) or the directory it prints.
- Clean the repository: \`gsp clean --json\` to read the plan, then \`gsp clean --yes\`.
- Delete one branch: \`gsp clean <branch> --yes\`. Add \`--force\` only when the person agreed; \`gsp restore\` can bring the branch back.
- Remove a worktree you created (review, scratch): \`gsp worktree remove <path>\`. If it is kept, read why. Add \`--discard-changes\` only when everything listed is yours to throw away: uncommitted changes and ignored files are deleted for good.
- List worktrees: \`gsp worktree list --json\`.
- Working in a worktree of your own: run \`git worktree lock <path>\` while you work, so no cleanup removes it, and \`git worktree unlock <path>\` when you are done.
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
<!-- END:git-sweep-pro -->`;

/** The note gsp 1.3.0 wrote, as people copied it without its markers. */
const OLD_NOTE = ['## Git cleanup', '', 'Use the `gsp` CLI to clean up the Git workspace. Run `gsp help` to see its commands.'].join('\n');

/** A note of 1.x that someone edited: no longer word for word what gsp wrote. */
const EDITED_NOTE = [
	'## Git cleanup',
	'',
	'Use the `gsp` CLI to clean up the Git workspace. Run `gsp help` to see its commands.',
	'',
	'Run `gsp list --json` to inspect candidates before deleting. It returns `stale`, `protected`, `checkedOut`, `merged` and `worktrees`.',
].join('\n');

suite('agent instructions', () => {
	test('the note matches its snapshot and stays short', () => {
		assert.strictEqual(AGENT_BLOCK, NOTE);
		assert.ok(AGENT_BLOCK.split('\n').length <= 40);
	});

	test('the README carries the same note, for files outside a repository', () => {
		const readme = fs.readFileSync(path.join(__dirname, '../../../README.md'), 'utf8');
		assert.ok(readme.includes(AGENT_BLOCK), 'copy AGENT_BLOCK into the "For coding agents" section of the README');
	});

	suite('upsertAgentBlock', () => {
		test('fills an empty file with the block', () => {
			assert.strictEqual(upsertAgentBlock(''), `${AGENT_BLOCK}\n`);
		});

		test('appends the block after a blank line', () => {
			assert.strictEqual(upsertAgentBlock('# Rules\n'), `# Rules\n\n${AGENT_BLOCK}\n`);
			assert.strictEqual(upsertAgentBlock('# Rules'), `# Rules\n\n${AGENT_BLOCK}\n`);
		});

		test('replaces an outdated block in place and leaves the rest alone', () => {
			const outdated = '# Rules\n\n<!-- BEGIN:git-sweep-pro -->\nold\n<!-- END:git-sweep-pro -->\n\n## More\n';
			assert.strictEqual(upsertAgentBlock(outdated), `# Rules\n\n${AGENT_BLOCK}\n\n## More\n`);
		});

		test('replaces a copy of a past note without markers in place, whatever its whitespace, and keeps the text after it', () => {
			const content = `# Rules\n\n${OLD_NOTE}\n\n## More\n\nMy own paragraph about cleanup.\n`;
			const once = upsertAgentBlock(content);
			assert.strictEqual(once, `# Rules\n\n${AGENT_BLOCK}\n\n## More\n\nMy own paragraph about cleanup.\n`);
			assert.strictEqual(upsertAgentBlock(once), once);
			// Someone added to it: replacing the note alone would leave their paragraph under another heading.
			const added = `${OLD_NOTE}\n\nMy own paragraph about cleanup.\n`;
			assert.deepStrictEqual(planAgentBlock(added), { content: `${added}\n${AGENT_BLOCK}\n`, change: 'added', review: [1] });
		});

		test('replaces an older note at the end of a file', () => {
			assert.strictEqual(upsertAgentBlock(`# Rules\n\n${OLD_NOTE}\n`), `# Rules\n\n${AGENT_BLOCK}\n`);
		});

		test('replaces a past note copied with other whitespace', () => {
			const spaced = '## Git cleanup\n\nUse the `gsp` CLI   to clean up the Git\nworkspace. Run `gsp help` to see its commands.  \n';
			assert.strictEqual(upsertAgentBlock(spaced), `${AGENT_BLOCK}\n`);
		});

		test('leaves a "Git cleanup" section of someone\'s own in place, appends the block, and reports the section', () => {
			for (const content of ['## Git cleanup\n\nDelete branches by hand.\n', `# Rules\n\n${EDITED_NOTE}\n`]) {
				const plan = planAgentBlock(content);
				assert.deepStrictEqual([plan.content, plan.change], [`${content}\n${AGENT_BLOCK}\n`, 'added']);
			}
			assert.deepStrictEqual(planAgentBlock('## Git cleanup\n\nDelete branches by hand.\n').review, [], 'it does not mention gsp');
			assert.deepStrictEqual(planAgentBlock(`# Rules\n\n${EDITED_NOTE}\n`).review, [3]);
		});

		test('replaces one past note and reports the others', () => {
			const twice = `${OLD_NOTE}\n\n# Other\n\n${OLD_NOTE}\n`;
			const plan = planAgentBlock(twice);
			const blockLines = AGENT_BLOCK.split('\n').length;
			// Lines of the file written: the block replaced the first note's 3 lines.
			assert.deepStrictEqual([plan.content, plan.change, plan.review], [`${AGENT_BLOCK}\n\n# Other\n\n${OLD_NOTE}\n`, 'replaced', [blockLines + 4]]);
			const marked = planAgentBlock(`${AGENT_BLOCK}\n\n${OLD_NOTE}\n`);
			assert.deepStrictEqual([marked.change, marked.review], ['unchanged', [blockLines + 2]]);
		});

		test('ignores markers and notes inside code blocks', () => {
			const example = `# Rules\n\n\`\`\`markdown\n${AGENT_BLOCK}\n\n${OLD_NOTE}\n\`\`\`\n`;
			assert.strictEqual(upsertAgentBlock(example), `${example}\n${AGENT_BLOCK}\n`);
			const lone = '~~~\n<!-- BEGIN:git-sweep-pro -->\n~~~\n';
			assert.strictEqual(upsertAgentBlock(lone), `${lone}\n${AGENT_BLOCK}\n`);
		});

		test('refuses unbalanced markers instead of guessing which span to replace', () => {
			const start = '<!-- BEGIN:git-sweep-pro -->';
			const end = '<!-- END:git-sweep-pro -->';
			for (const content of [
				`# Rules\n${start}\nmine\n`,
				`${end}\n# Rules\n`,
				`${end}\nmine\n${start}\n`,
				`${start}\na\n${end}\n${start}\nb\n${end}\n`,
			]) {
				assert.throws(() => upsertAgentBlock(content), /its gsp markers are unbalanced/, content);
			}
		});

		test('is idempotent', () => {
			const once = upsertAgentBlock('# Rules\n');
			assert.strictEqual(upsertAgentBlock(once), once);
		});

		test('keeps Windows line endings', () => {
			const result = upsertAgentBlock('# Rules\r\n');
			assert.strictEqual(result, `# Rules\r\n\r\n${AGENT_BLOCK.replace(/\n/g, '\r\n')}\r\n`);
			assert.ok(!/[^\r]\n/.test(result));
		});

		test("writes the block with the file's dominant line ending, and leaves each other line's own", () => {
			const mixed = '# Rules\nOne\nTwo\r\nThree\n';
			assert.strictEqual(upsertAgentBlock(mixed), `${mixed}\n${AGENT_BLOCK}\n`);
			const replaced = upsertAgentBlock(`# Rules\r\n\r\n${OLD_NOTE.replace(/\n/g, '\r\n')}\r\n\r\n# Next\n`);
			assert.strictEqual(replaced, `# Rules\r\n\r\n${AGENT_BLOCK.replace(/\n/g, '\r\n')}\r\n\r\n# Next\n`);
		});
	});

	suite('runAgentsWorkflow', () => {
		let root: string;
		const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

		setup(() => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsp-agents-'));
		});

		teardown(() => {
			fs.rmSync(root, { recursive: true, force: true });
		});

		test('writes the requested files without asking, and reports what changed', async () => {
			fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\n');
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['AGENTS.md', 'CLAUDE.md']), 'ok');

			assert.strictEqual(read('AGENTS.md'), `# Rules\n\n${AGENT_BLOCK}\n`);
			assert.strictEqual(read('CLAUDE.md'), `${AGENT_BLOCK}\n`);
			assert.deepStrictEqual(fake.pickManyRequests, []);
			assert.deepStrictEqual(fake.infoMessages, [
				'Added the gsp instructions to AGENTS.md. Created CLAUDE.md with the gsp instructions.',
			]);

			const again = createFakeContext({ root });
			await runAgentsWorkflow(again.context, ['CLAUDE.md']);
			assert.deepStrictEqual(again.infoMessages, ['CLAUDE.md already has the gsp instructions.']);
		});

		test('offers both files, pre-selecting AGENTS.md when neither exists', async () => {
			const fake = createFakeContext({ root, pickMany: (items) => items.filter((item) => item.picked).map((item) => item.label) });

			assert.strictEqual(await runAgentsWorkflow(fake.context, []), 'ok');

			assert.deepStrictEqual(fake.pickManyRequests[0].items, [
				{ label: 'AGENTS.md', description: 'Codex, Cursor, GitHub Copilot, OpenCode', picked: true },
				{ label: 'CLAUDE.md', description: 'Claude Code', picked: false },
			]);
			assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
			assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')));
		});

		test('pre-selects the files that already exist', async () => {
			fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
			const fake = createFakeContext({ root });

			await runAgentsWorkflow(fake.context, []);

			assert.deepStrictEqual(
				fake.pickManyRequests[0].items.map((item) => item.picked),
				[false, true]
			);
		});

		test('changes nothing when no file is picked', async () => {
			const fake = createFakeContext({ root, pickMany: () => [] });

			assert.strictEqual(await runAgentsWorkflow(fake.context, []), 'cancelled');

			assert.deepStrictEqual(fs.readdirSync(root), []);
			assert.deepStrictEqual(fake.infoMessages, ['No files selected.']);
		});

		test('reports an older note it replaced', async () => {
			fs.writeFileSync(path.join(root, 'CLAUDE.md'), `${OLD_NOTE}\n`);
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['CLAUDE.md']), 'ok');

			assert.strictEqual(read('CLAUDE.md'), `${AGENT_BLOCK}\n`);
			assert.deepStrictEqual(fake.infoMessages, ['Replaced the older gsp note in CLAUDE.md with the current instructions.']);
		});

		test('follows a symbolic link within the repository', async () => {
			fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\n');
			fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['CLAUDE.md', 'AGENTS.md']), 'ok');

			assert.ok(fs.lstatSync(path.join(root, 'CLAUDE.md')).isSymbolicLink());
			assert.strictEqual(read('AGENTS.md'), `# Rules\n\n${AGENT_BLOCK}\n`);
			assert.deepStrictEqual(fake.infoMessages, [
				'Added the gsp instructions to CLAUDE.md. AGENTS.md already has the gsp instructions.',
			]);
		});

		test('never writes through a symbolic link that leaves the repository', async () => {
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsp-outside-'));
			fs.writeFileSync(path.join(outside, 'notes.md'), 'private\n');
			fs.symlinkSync(path.join(outside, 'notes.md'), path.join(root, 'AGENTS.md'));
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['AGENTS.md']), 'failed');

			assert.strictEqual(fs.readFileSync(path.join(outside, 'notes.md'), 'utf8'), 'private\n');
			assert.match(fake.errorMessages[0], /^Unable to write AGENTS\.md: it links to .*notes\.md, outside the repository\.$/);
			fs.rmSync(outside, { recursive: true, force: true });
		});

		test('never creates a file through a dangling symbolic link that leaves the repository', async () => {
			const outside = path.join(os.tmpdir(), `gsp-missing-${process.pid}.md`);
			fs.symlinkSync(outside, path.join(root, 'AGENTS.md'));
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['AGENTS.md']), 'failed');

			assert.ok(!fs.existsSync(outside));
			assert.match(fake.errorMessages[0], /which does not exist and is outside the repository\. Replace the link with a file\.$/);
		});

		test('never creates a file through a dangling link to another link that leaves the repository', async () => {
			const outside = path.join(os.tmpdir(), `gsp-chained-${process.pid}.md`);
			fs.symlinkSync(outside, path.join(root, 'notes.md'));
			fs.symlinkSync('notes.md', path.join(root, 'CLAUDE.md'));
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['CLAUDE.md']), 'failed');

			assert.ok(!fs.existsSync(outside));
			assert.match(fake.errorMessages[0], /another link to a file that does not exist\. Replace the link with a file\.$/);
		});

		test('creates the file a dangling symbolic link points to, within the repository', async () => {
			fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['CLAUDE.md']), 'ok');

			assert.ok(fs.lstatSync(path.join(root, 'CLAUDE.md')).isSymbolicLink());
			assert.strictEqual(read('AGENTS.md'), `${AGENT_BLOCK}\n`);
			assert.deepStrictEqual(fake.infoMessages, ['Created CLAUDE.md with the gsp instructions.']);

			fs.symlinkSync('missing/AGENTS.md', path.join(root, 'GONE.md'));
			fs.rmSync(path.join(root, 'CLAUDE.md'));
			fs.symlinkSync('missing/AGENTS.md', path.join(root, 'CLAUDE.md'));
			const missing = createFakeContext({ root });
			assert.strictEqual(await runAgentsWorkflow(missing.context, ['CLAUDE.md']), 'failed');
			assert.match(missing.errorMessages[0], /whose folder does not exist\. Create it, or replace the link with a file\.$/);
		});

		test('reports a section of someone\'s own it left in place', async () => {
			fs.writeFileSync(path.join(root, 'AGENTS.md'), `# Rules\n\n${EDITED_NOTE}\n`);
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['AGENTS.md']), 'ok');

			assert.strictEqual(read('AGENTS.md'), `# Rules\n\n${EDITED_NOTE}\n\n${AGENT_BLOCK}\n`);
			assert.deepStrictEqual(fake.infoMessages, [
				'Added the gsp instructions to AGENTS.md. AGENTS.md still has an older "Git cleanup" section at line 3, left as it is: review it, and remove what the gsp instructions now cover.',
			]);
		});

		test('leaves a file with a lone start marker untouched', async () => {
			const damaged = '# Rules\n<!-- BEGIN:git-sweep-pro -->\nmy own notes\n';
			fs.writeFileSync(path.join(root, 'AGENTS.md'), damaged);
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['AGENTS.md']), 'failed');

			assert.strictEqual(read('AGENTS.md'), damaged);
			assert.deepStrictEqual(fake.errorMessages, [
				'Unable to write AGENTS.md: its gsp markers are unbalanced. Remove them, then run gsp agents again.',
			]);
		});

		test('reports a file it cannot write', async () => {
			fs.mkdirSync(path.join(root, 'AGENTS.md'));
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['AGENTS.md']), 'failed');

			assert.strictEqual(fake.errorMessages.length, 1);
			assert.match(fake.errorMessages[0], /^Unable to write AGENTS\.md: /);
		});
	});

	suite('checkAgentAdvice', () => {
		const rules = (content: string, writable = true) => checkAgentAdvice('AGENTS.md', content, writable).map((finding) => [finding.line, finding.rule]);

		test('finds nothing in the current note', () => {
			assert.deepStrictEqual(rules(`# Rules\n\n${AGENT_BLOCK}\n`), []);
		});

		test('reports an outdated note once, by its heading, and suggests what can rewrite it', () => {
			const marked = `<!-- BEGIN:git-sweep-pro -->\n${EDITED_NOTE}\n<!-- END:git-sweep-pro -->\n`;
			assert.deepStrictEqual(rules(marked), [[2, 'outdated-note']]);
			assert.deepStrictEqual(rules(`# Rules\n\n${OLD_NOTE}\n`), [[3, 'outdated-note']]);
			assert.match(checkAgentAdvice('AGENTS.md', OLD_NOTE, true)[0].suggestion, /gsp agents AGENTS\.md/);
			assert.match(checkAgentAdvice('/home/me/AGENTS.md', OLD_NOTE, false)[0].suggestion, /README/);
		});

		test('reports a second old note, and a section of someone\'s own, as gsp agents leaves them', () => {
			const findings = checkAgentAdvice('AGENTS.md', `${OLD_NOTE}\n\n# Other\n\n${OLD_NOTE}\n\n# Mine\n\n${EDITED_NOTE}\n`, true);
			assert.deepStrictEqual(
				findings.map((finding) => [finding.line, finding.rule]),
				[
					[1, 'outdated-note'],
					[7, 'outdated-note'],
					[13, 'outdated-note'],
					[17, 'old-list-json'],
				]
			);
			assert.match(findings[1].suggestion, /replaces only one/);
			assert.match(findings[2].suggestion, /^Review this section/);
		});

		test('skips code blocks', () => {
			assert.deepStrictEqual(rules('Example:\n\n```sh\ngit branch -D old\ngit worktree remove /tmp/x\n```\n\n~~~\n## Git cleanup\n\nUse gsp.\n~~~\n'), []);
		});

		test('reports raw Git that gsp replaces, with the gsp command to use', () => {
			const content = [
				'Once merged, run `git branch -D feature/x`.',
				'Remove review worktrees with `git worktree remove --force /tmp/review`.',
				'Then `git push origin --delete feature/x`.',
				'Or `git push origin :feature/x`.',
				'List merged branches with `git branch --merged`.',
			].join('\n');
			assert.deepStrictEqual(rules(content), [
				[1, 'raw-branch-delete'],
				[2, 'raw-worktree-remove'],
				[3, 'raw-push-delete'],
				[4, 'raw-push-delete'],
				[5, 'merged-flag'],
			]);
			assert.match(checkAgentAdvice('AGENTS.md', content, true)[1].suggestion, /gsp worktree remove <path>/);
		});

		test('reports stale beliefs about gsp', () => {
			const content = [
				'gsp has no worktree command, so use git.',
				'`gsp list --json` returns `stale` and `checkedOut`.',
				'`gsp sweep --yes` force-deletes unmerged branches.',
				'Run gsp list --json and read stale and checkedOut.',
				'After merging, run `gsp post-pr main`.',
				'Throw a review worktree away with `gsp worktree remove /tmp/review --force`.',
			].join('\n');
			assert.deepStrictEqual(rules(content), [
				[1, 'no-worktree-command'],
				[2, 'old-list-json'],
				[3, 'yes-forces'],
				[4, 'old-list-json'],
				[5, 'post-pr-default'],
				[6, 'worktree-remove-force'],
			]);
		});

		test('judges raw Git by the clause it is in, not the whole line', () => {
			const content = [
				'Use gsp for cleanup; for a one-off branch, run `git branch -D x`.',
				"Clean up with gsp. Don't run `git worktree remove`.",
				'Prefer gsp, but `git push origin --delete x` works too.',
			].join('\n');
			assert.deepStrictEqual(rules(content), [
				[1, 'raw-branch-delete'],
				[3, 'raw-push-delete'],
			]);
		});

		test('leaves alone lines that warn against raw Git or describe what gsp does', () => {
			const content = [
				"Don't use `git branch -D`: use gsp.",
				'Never run `git worktree remove` on a dirty worktree.',
				'gsp falls back to `git branch -D` once the tip is checked.',
				'`gsp restore` cannot bring back ignored files. A worktree with them is kept.',
			].join('\n');
			assert.deepStrictEqual(rules(content), []);
		});

		test('reads Windows line endings', () => {
			assert.deepStrictEqual(rules(`${AGENT_BLOCK}\r\ngit worktree remove x\r\n`.replace(/(?<!\r)\n/g, '\r\n')), [[AGENT_BLOCK.split('\n').length + 1, 'raw-worktree-remove']]);
		});
	});
});
