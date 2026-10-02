import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_BLOCK, runAgentsWorkflow, upsertAgentBlock } from '../../core/agent-instructions';
import { createFakeContext } from '../fake-context';

suite('agent instructions', () => {
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

		test('never creates a file through a dangling symbolic link', async () => {
			const outside = path.join(os.tmpdir(), `gsp-missing-${process.pid}.md`);
			fs.symlinkSync(outside, path.join(root, 'AGENTS.md'));
			const fake = createFakeContext({ root });

			assert.strictEqual(await runAgentsWorkflow(fake.context, ['AGENTS.md']), 'failed');

			assert.ok(!fs.existsSync(outside));
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
});
