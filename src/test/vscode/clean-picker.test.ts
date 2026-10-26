import * as assert from 'assert';
import * as vscode from 'vscode';
import type { CleanDocument } from '../../core/clean-plan';
import { showCleanPicker } from '../../vscode/clean-picker';
import type { CleanPickerOptions } from '../../vscode/command-ui';
import { branch, cleanDocument, remoteBranch } from './fakes';

type Item = vscode.QuickPickItem & { entry?: { arg: string } };

/** A quick pick a test drives: it records what the picker sets and fires the user's events. */
function createFakeQuickPick() {
	const listeners: Record<string, ((value?: unknown) => void)[]> = {};
	const on = (event: string) => (listener: (value?: unknown) => void) => {
		(listeners[event] ??= []).push(listener);
		return { dispose: () => undefined };
	};
	const fire = (event: string, value?: unknown) => listeners[event]?.forEach((listener) => listener(value));
	const quickPick = {
		title: '',
		placeholder: '',
		canSelectMany: false,
		ignoreFocusOut: false,
		matchOnDescription: false,
		matchOnDetail: false,
		busy: false,
		enabled: true,
		buttons: [] as readonly vscode.QuickInputButton[],
		items: [] as readonly Item[],
		activeItems: [] as readonly Item[],
		selectedItems: [] as readonly Item[],
		onDidChangeSelection: on('selection'),
		onDidTriggerButton: on('button'),
		onDidTriggerItemButton: on('itemButton'),
		onDidAccept: on('accept'),
		onDidHide: on('hide'),
		show: () => undefined,
		hidden: false,
		hide: () => {
			if (!quickPick.hidden) {
				quickPick.hidden = true;
				fire('hide');
			}
		},
		dispose: () => undefined,
	};
	const args = () => quickPick.selectedItems.map((item) => item.entry?.arg);
	return {
		quickPick,
		fire,
		args,
		/** The user unchecks an item. */
		uncheck: (arg: string) => {
			quickPick.selectedItems = quickPick.selectedItems.filter((item) => item.entry?.arg !== arg);
			fire('selection', quickPick.selectedItems);
		},
		/** The user checks an item: the selection changes, then VS Code reports it. */
		check: (arg: string) => {
			const item = quickPick.items.find((candidate) => candidate.entry?.arg === arg)!;
			quickPick.selectedItems = [...quickPick.selectedItems, item];
			fire('selection', quickPick.selectedItems);
		},
		button: (tooltip: string) => fire('button', quickPick.buttons.find((button) => button.tooltip?.toString().startsWith(tooltip))),
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const unpushed = branch({ name: 'feature/unpushed', action: 'skip', reason: 'needs-force', verdictReason: 'upstream-gone', upstream: 'origin/x', unpushedCommits: 1, hint: 'gsp clean feature/unpushed --yes --force' });
const dirty = branch({ name: 'feature/dirty', action: 'skip', reason: 'dirty-worktree', hint: 'git stash' });
const plan = cleanDocument([branch({ name: 'feature/a' }), unpushed, dirty, branch({ name: 'main', action: 'keep', reason: 'default-branch', verdict: 'alive', verdictReason: 'default-branch' })]);

suite('clean picker', () => {
	let original: typeof vscode.window.createQuickPick;
	let fake: ReturnType<typeof createFakeQuickPick>;

	setup(() => {
		original = vscode.window.createQuickPick;
		fake = createFakeQuickPick();
		(vscode.window as { createQuickPick: unknown }).createQuickPick = () => fake.quickPick;
	});
	teardown(() => {
		(vscode.window as { createQuickPick: unknown }).createQuickPick = original;
	});

	const open = (options: Partial<CleanPickerOptions> & { plan: Promise<CleanDocument | undefined> }) =>
		showCleanPicker({ title: 'Sweep stale branches', readOnly: false, force: false, confirm: true, ...options });

	test('opens busy, then lists sections with planned deletions checked', async () => {
		let resolvePlan!: (document: CleanDocument) => void;
		const pick = open({ plan: new Promise((resolve) => (resolvePlan = resolve)) });
		assert.deepStrictEqual([fake.quickPick.busy, fake.quickPick.enabled, fake.quickPick.placeholder], [true, false, 'Reading branches…']);

		resolvePlan(plan);
		await tick();
		assert.deepStrictEqual(fake.quickPick.items.map((item) => (item.kind === vscode.QuickPickItemKind.Separator ? `-- ${item.label}` : item.entry?.arg)), [
			'-- To delete',
			'feature/a',
			'-- Skipped',
			'feature/unpushed',
			'feature/dirty',
			'-- Kept',
			'main',
		]);
		assert.deepStrictEqual(fake.args(), ['feature/a']);
		assert.strictEqual(fake.quickPick.items.find((item) => item.entry?.arg === 'feature/dirty')?.buttons?.[0].tooltip, 'Copy the fix: git stash');

		fake.fire('accept');
		const result = await pick;
		assert.deepStrictEqual(result.kind === 'picked' && result.entries.map((entry) => entry.arg), ['feature/a']);
	});

	test('a skipped branch cannot be checked: the click is undone and the placeholder says why', async () => {
		void open({ plan: Promise.resolve(plan) });
		await tick();

		fake.check('feature/dirty');
		assert.deepStrictEqual(fake.args(), ['feature/a']);
		assert.strictEqual(fake.quickPick.placeholder, "feature/dirty can't be deleted here: its worktree has uncommitted changes.");

		// The echo of the revert keeps the notice; the next real change clears it.
		fake.fire('selection', fake.quickPick.selectedItems);
		assert.ok(fake.quickPick.placeholder.startsWith('feature/dirty'));
		fake.fire('selection', []);
		assert.strictEqual(fake.quickPick.placeholder, 'Pick the branches to delete, then press Enter to review them.');
	});

	test('the force toggle offers forced deletes unchecked, keeps the selection, and select all skips them', async () => {
		void open({ plan: Promise.resolve(plan) });
		await tick();

		const forceIcon = () => (fake.quickPick.buttons[0].iconPath as vscode.ThemeIcon).id;
		assert.strictEqual(forceIcon(), 'shield', 'the toggle shows it is off');
		fake.button('Forced deletes are hidden');
		assert.strictEqual(forceIcon(), 'warning', 'the toggle shows it is on');
		assert.ok(fake.quickPick.items.some((item) => item.label === 'Needs a forced delete'));
		assert.deepStrictEqual(fake.args(), ['feature/a']);
		fake.button('Clear all');
		assert.deepStrictEqual(fake.args(), []);
		fake.button('Select all');
		assert.deepStrictEqual(fake.args(), ['feature/a']);
		fake.check('feature/unpushed');
		assert.deepStrictEqual(fake.args(), ['feature/a', 'feature/unpushed']);

		fake.button('Forced deletes are offered');
		assert.deepStrictEqual(fake.args(), ['feature/a'], 'hidden forced deletes are unchecked');
	});

	test('without a confirmation, the placeholder says Enter deletes', async () => {
		void open({ confirm: false, plan: Promise.resolve(plan) });
		await tick();
		assert.strictEqual(fake.quickPick.placeholder, 'Pick the branches to delete, then press Enter to delete them.');
	});

	test('a note about the plan comes first and cannot be checked', async () => {
		void open({ plan: Promise.resolve(plan), note: Promise.resolve("Remote branches aren't shown: no remote is named origin.") });
		await tick();
		const noteItem = fake.quickPick.items[0];
		assert.strictEqual(noteItem.label, "$(info) Remote branches aren't shown: no remote is named origin.");
		fake.quickPick.selectedItems = [...fake.quickPick.selectedItems, noteItem];
		fake.fire('selection', fake.quickPick.selectedItems);
		assert.deepStrictEqual(fake.args(), ['feature/a']);
		assert.strictEqual(fake.quickPick.placeholder, "Remote branches aren't shown: no remote is named origin.");
	});

	test('a remote branch goes only with the local branch tracking it', async () => {
		const tracked = cleanDocument([branch({ name: 'feature/a' })], { remoteBranches: [remoteBranch({ name: 'feature/a', trackedBy: ['feature/a'] })] });
		void open({ plan: Promise.resolve(tracked) });
		await tick();
		assert.deepStrictEqual(fake.args(), ['feature/a', 'origin/feature/a']);

		fake.uncheck('feature/a');
		assert.deepStrictEqual(fake.args(), []);
		assert.strictEqual(fake.quickPick.placeholder, 'origin/feature/a was unchecked too: feature/a tracks it, so it stays while feature/a is kept.');

		fake.check('origin/feature/a');
		assert.deepStrictEqual(fake.args(), []);
		assert.strictEqual(fake.quickPick.placeholder, "origin/feature/a can't be deleted alone: feature/a tracks it. Check feature/a too.");

		fake.check('feature/a');
		fake.check('origin/feature/a');
		assert.deepStrictEqual(fake.args(), ['feature/a', 'origin/feature/a']);
	});

	test('the copy button copies the fix', async () => {
		void open({ plan: Promise.resolve(plan) });
		await tick();
		await vscode.env.clipboard.writeText('');
		fake.fire('itemButton', { item: fake.quickPick.items.find((item) => item.entry?.arg === 'feature/dirty') });
		await tick();
		assert.strictEqual(await vscode.env.clipboard.readText(), 'git stash');
	});

	test('a preview selects nothing and closes on accept; an empty plan, a failed plan and hiding resolve without entries', async () => {
		const preview = open({ readOnly: true, plan: Promise.resolve(plan) });
		await tick();
		assert.deepStrictEqual([fake.quickPick.canSelectMany, fake.args(), fake.quickPick.buttons.length], [false, [], 0]);
		fake.fire('accept');
		assert.deepStrictEqual(await preview, { kind: 'closed' });

		fake = createFakeQuickPick();
		assert.deepStrictEqual(await open({ plan: Promise.resolve(cleanDocument([plan.branches[3]])) }), { kind: 'empty' });
		fake = createFakeQuickPick();
		assert.deepStrictEqual(await open({ plan: Promise.resolve(undefined) }), { kind: 'closed' });
		fake = createFakeQuickPick();
		const hidden = open({ plan: Promise.resolve(plan) });
		await tick();
		fake.quickPick.hide();
		assert.deepStrictEqual(await hidden, { kind: 'closed' });
	});
});
