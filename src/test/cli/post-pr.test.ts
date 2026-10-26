import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../../cli/app';
import { EXIT } from '../../cli/args';
import type { CleanBranch } from '../../core/clean-plan';
import type { PostPrDocument, PostPrReport } from '../../core/post-pull-request-plan';
import { createFakePrompter } from './fake-prompter';
import { branchExists, commitFile, createFakeIo, createRepoFixture, git, makeGoneBranch, type RepoFixture } from './git-fixture';

/*
 * `gsp post-pr` against real repositories with a bare origin: the pull
 * request is squash-merged on the remote by another clone, as GitHub does.
 */
suite('cli post-pr (real git)', function () {
	this.timeout(60000);
	let fx: RepoFixture;

	setup(() => {
		fx = createRepoFixture();
	});

	teardown(() => {
		fx.cleanup();
	});

	/** A branch with one commit, pushed, in a linked worktree next to the repository. */
	function addFeatureWorktree(name: string): string {
		const wt = path.join(fx.dir, name.replace(/\//g, '-'));
		git(['worktree', 'add', '-q', '-b', name, wt], fx.repo);
		commitFile(wt, `${name.replace(/\//g, '-')}.txt`, `${name}\n`, `work on ${name}`);
		git(['push', '-q', '-u', 'origin', name], wt);
		return fs.realpathSync(wt);
	}

	/** Squash-merges `branch` into main on the remote and deletes it there, from another clone. */
	function squashMergeOnRemote(branch: string): void {
		const merger = path.join(fx.dir, 'merger');
		if (!fs.existsSync(merger)) {
			git(['clone', '-q', fx.remote, merger], fx.dir);
		}
		git(['fetch', '-q', 'origin'], merger);
		git(['checkout', '-q', '-B', 'main', 'origin/main'], merger);
		git(['merge', '-q', '--squash', `origin/${branch}`], merger);
		git(['commit', '-q', '-m', `${branch} (#1)`], merger);
		git(['push', '-q', 'origin', 'main', `:${branch}`], merger);
	}

	/** The report of a run that had a branch to finish, or none. */
	function json(out: readonly string[]): PostPrReport & { readonly branch: CleanBranch | null } {
		return JSON.parse(out.join('')) as PostPrReport & { readonly branch: CleanBranch | null };
	}

	const tip = (ref: string, cwd = fx.repo) => git(['rev-parse', ref], cwd).trim();
	const headOf = (cwd: string) => git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
	const mainCheckout = () => fs.realpathSync(fx.repo);

	test('from the linked worktree of a squash-merged branch: removes it, deletes the branch and updates main', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json'], io), EXIT.ok, io.err.join(''));
		const report = json(io.out);
		assert.strictEqual(report.command, 'post-pr');
		assert.strictEqual(report.mode, 'apply');
		assert.strictEqual(report.branch?.name, 'feature/x');
		assert.strictEqual(report.branch?.result, 'deleted');
		assert.deepStrictEqual(report.worktree, { path: wt, removed: true, switched: false });
		assert.strictEqual(report.nextCwd, mainCheckout());
		assert.strictEqual(report.restore, 'gsp restore feature/x');
		assert.strictEqual(report.defaultBranch.updated, true);
		assert.strictEqual(report.defaultBranch.where, mainCheckout());

		assert.ok(!fs.existsSync(wt), 'worktree removed');
		assert.ok(!branchExists(fx.repo, 'feature/x'));
		assert.strictEqual(tip('main'), tip('origin/main'), 'main fast-forwarded in the main checkout');
		assert.strictEqual(git(['status', '--porcelain'], fx.repo).trim(), '', 'the main checkout is clean');

		const restore = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['restore', 'feature/x'], restore), EXIT.ok);
		assert.ok(restore.err.join('').includes(`git worktree add ${wt} feature/x`), restore.err.join(''));
	});

	test('prints one line per change, then where to continue', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes'], io), EXIT.ok, io.err.join(''));
		const out = io.out.join('');
		assert.match(out, /^deleted feature\/x {2}\S+ into origin\/main, removed worktree /m);
		assert.match(out, /^main: fast-forwarded to origin\/main \(\w{7}\.\.\w{7}\) in /m);
		assert.strictEqual(out.match(/nothing to clean/gi)?.length, 1, out);
		assert.ok(out.includes(`Continue in the main checkout: cd ${mainCheckout()}`), out);
	});

	test('from the main checkout on the merged branch: switches it to main first', async () => {
		git(['checkout', '-q', '-b', 'feature/x'], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\n', 'work');
		git(['push', '-q', '-u', 'origin', 'feature/x'], fx.repo);
		squashMergeOnRemote('feature/x');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json'], io), EXIT.ok, io.err.join(''));
		const report = json(io.out);
		assert.deepStrictEqual(report.worktree, { path: mainCheckout(), removed: false, switched: true });
		assert.strictEqual(report.nextCwd, null);
		assert.strictEqual(headOf(fx.repo), 'main');
		assert.strictEqual(tip('main'), tip('origin/main'));
		assert.ok(!branchExists(fx.repo, 'feature/x'));
	});

	test('from the main checkout, naming a branch checked out in a linked worktree', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'feature/x', '--yes', '--json'], io), EXIT.ok, io.err.join(''));
		assert.strictEqual(json(io.out).nextCwd, null, 'gsp did not run in the removed worktree');
		assert.ok(!fs.existsSync(wt));
		assert.ok(!branchExists(fx.repo, 'feature/x'));
		assert.strictEqual(tip('main'), tip('origin/main'));
	});

	test('already on the default branch: updates it and cleans', async () => {
		makeGoneBranch(fx.repo, 'feature/old');
		commitFile(fx.repo, 'ahead.txt', 'ahead\n', 'main moves on');
		git(['push', '-q', 'origin', 'main'], fx.repo);
		git(['reset', '-q', '--hard', 'HEAD~1'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', '--yes'], io), EXIT.ok, io.err.join(''));
		const out = io.out.join('');
		assert.ok(out.startsWith('No branch to finish: on main.\n'), out);
		assert.ok(out.includes('Other branches: 1 deleted (1 empty)'), out);
		assert.ok(out.includes('Undo with: gsp restore feature/old'), out);
		assert.strictEqual(tip('main'), tip('origin/main'));
		assert.ok(!branchExists(fx.repo, 'feature/old'));
	});

	test('a branch that is not merged is kept: nothing changes on it, exit 5 and a hint', async () => {
		const wt = addFeatureWorktree('feature/open');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json'], io), EXIT.notApplied, io.err.join(''));
		const report = json(io.out);
		assert.strictEqual(report.branch?.action, 'skip');
		assert.strictEqual(report.branch?.reason, 'needs-force');
		assert.strictEqual(report.branch?.verdictReason, 'unmerged-commits');
		assert.strictEqual(report.branch?.hint, 'gsp post-pr feature/open --yes --force');
		assert.deepStrictEqual(report.worktree, { path: wt, removed: false, switched: false });
		assert.strictEqual(report.nextCwd, null);
		assert.ok(fs.existsSync(wt));
		assert.ok(branchExists(fx.repo, 'feature/open'));

		const text = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes'], text), EXIT.notApplied);
		assert.ok(text.out.join('').includes('1 commit not merged into origin/main) → gsp post-pr feature/open --yes --force'), text.out.join(''));
	});

	test('--force deletes a branch that is not merged, and its worktree', async () => {
		const wt = addFeatureWorktree('feature/closed');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--force'], io), EXIT.ok, io.err.join(''));
		assert.ok(!fs.existsSync(wt));
		assert.ok(!branchExists(fx.repo, 'feature/closed'));
	});

	test('--force never deletes a protected branch', async () => {
		const wt = addFeatureWorktree('release/1');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--force', '--protect', 'release/*'], io), EXIT.notApplied, io.err.join(''));
		assert.ok(fs.existsSync(wt));
		assert.ok(branchExists(fx.repo, 'release/1'));
	});

	test('a worktree with uncommitted changes is kept, and so is its branch', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');
		fs.writeFileSync(path.join(wt, 'wip.txt'), 'work in progress\n');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json'], io), EXIT.notApplied, io.err.join(''));
		const report = json(io.out);
		assert.strictEqual(report.branch?.reason, 'dirty-worktree');
		assert.strictEqual(report.branch?.hint, `git -C ${wt} stash --include-untracked && gsp post-pr feature/x --yes`);
		assert.ok(fs.existsSync(path.join(wt, 'wip.txt')));
		assert.ok(branchExists(fx.repo, 'feature/x'));
		assert.strictEqual(tip('main'), tip('origin/main'), 'main is still updated');
	});

	test('an untracked file keeps the worktree even when status.showUntrackedFiles hides it', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');
		git(['config', 'status.showUntrackedFiles', 'no'], fx.repo);
		fs.writeFileSync(path.join(wt, 'notes.md'), 'not committed\n');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json'], io), EXIT.notApplied, io.err.join(''));
		assert.strictEqual(json(io.out).branch?.reason, 'dirty-worktree');
		assert.ok(fs.existsSync(path.join(wt, 'notes.md')));
		assert.ok(branchExists(fx.repo, 'feature/x'));
	});

	test('a main checkout with uncommitted changes is not switched', async () => {
		git(['checkout', '-q', '-b', 'feature/x'], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\n', 'work');
		git(['push', '-q', '-u', 'origin', 'feature/x'], fx.repo);
		squashMergeOnRemote('feature/x');
		fs.writeFileSync(path.join(fx.repo, 'x.txt'), 'changed\n');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json'], io), EXIT.notApplied, io.err.join(''));
		const report = json(io.out);
		assert.strictEqual(report.branch?.reason, 'dirty-worktree');
		assert.strictEqual(report.branch?.hint, `git -C ${mainCheckout()} stash --include-untracked && gsp post-pr feature/x --yes`);
		assert.strictEqual(report.worktree.switched, false);
		assert.strictEqual(headOf(fx.repo), 'feature/x');
		assert.ok(branchExists(fx.repo, 'feature/x'));
		assert.strictEqual(tip('main'), tip('origin/main'), 'main, checked out nowhere, moves as a ref');
	});

	test('main checked out in a dirty main checkout is not updated, and the rest goes on', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');
		const before = tip('main');
		fs.writeFileSync(path.join(fx.repo, 'README.md'), 'local edit\n');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json'], io), EXIT.ok, io.err.join(''));
		const report = json(io.out);
		assert.strictEqual(report.branch?.result, 'deleted');
		assert.strictEqual(report.defaultBranch.updated, false);
		assert.strictEqual(report.defaultBranch.reason, 'dirty');
		assert.strictEqual(report.defaultBranch.hint, `git -C ${mainCheckout()} merge --ff-only origin/main`);
		assert.strictEqual(tip('main'), before);
		assert.strictEqual(fs.readFileSync(path.join(fx.repo, 'README.md'), 'utf8'), 'local edit\n');
	});

	test('--dry-run changes no ref, object or worktree, even with --yes', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');
		git(['fetch', '-q', 'origin'], fx.repo);
		const snapshot = () => [
			git(['for-each-ref'], fx.repo),
			git(['worktree', 'list', '--porcelain'], fx.repo),
			git(['count-objects', '-v'], fx.repo),
			headOf(fx.repo),
		];
		const before = snapshot();

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--dry-run', '--yes', '--json'], io), EXIT.notApplied, io.err.join(''));
		const report = json(io.out);
		assert.strictEqual(report.mode, 'plan');
		assert.strictEqual(report.branch?.action, 'delete');
		assert.strictEqual(report.branch?.hint, 'gsp post-pr feature/x --yes');
		assert.strictEqual(report.defaultBranch.reason, 'not-applied');
		assert.strictEqual(report.clean.checks.remote.source, 'ls-remote');
		assert.deepStrictEqual(snapshot(), before);
		assert.ok(fs.existsSync(wt));
	});

	test('without a terminal and without --yes, plans and exits 5', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr'], io), EXIT.notApplied, io.err.join(''));
		const out = io.out.join('');
		assert.ok(out.includes('origin/main has new commits that are not fetched yet'), out);
		assert.ok(out.includes('Nothing was changed. To apply this plan, run: gsp post-pr feature/x --yes'), out);
		assert.ok(!out.includes('--yes --force'), 'never suggests --force before fetching');

		// Its upstream pruned, its commit is found nowhere else until the merge is fetched: still fetch first, never push.
		git(['update-ref', '-d', 'refs/remotes/origin/feature/x'], fx.repo);
		const pruned = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--json'], pruned), EXIT.notApplied, pruned.err.join(''));
		assert.strictEqual(json(pruned.out).branch?.hint, 'gsp post-pr feature/x --yes');
		assert.ok(branchExists(fx.repo, 'feature/x'));
	});

	test('the old form "post-pr main" finishes the current branch, with a deprecation note', async () => {
		git(['checkout', '-q', '-b', 'feature/x'], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\n', 'work');
		git(['push', '-q', '-u', 'origin', 'feature/x'], fx.repo);
		squashMergeOnRemote('feature/x');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'main', '--yes'], io), EXIT.ok, io.err.join(''));
		assert.ok(io.err.join('').includes('"gsp post-pr main" is deprecated'), io.err.join(''));
		assert.strictEqual(headOf(fx.repo), 'main');
		assert.ok(!branchExists(fx.repo, 'feature/x'));
	});

	/** The current branch of the main checkout, squash-merged on the remote. */
	function mergedCurrentBranch(name: string): void {
		git(['checkout', '-q', '-b', name], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\n', 'work');
		git(['push', '-q', '-u', 'origin', name], fx.repo);
		squashMergeOnRemote(name);
	}

	test('the positional never lifts protection: a protected branch is read as the old form', async () => {
		git(['branch', 'develop', 'origin/main'], fx.repo);
		mergedCurrentBranch('feature/x');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'develop', '--protect', 'develop', '--yes'], io), EXIT.ok, io.err.join(''));
		assert.ok(io.err.join('').includes('develop is protected, so "gsp post-pr develop" is read as the deprecated'), io.err.join(''));
		assert.ok(branchExists(fx.repo, 'develop'), 'develop is never deleted');
		assert.ok(!branchExists(fx.repo, 'feature/x'));
	});

	test('from a linked worktree, the branch of the main checkout is read as the old form', async () => {
		git(['checkout', '-q', '-b', 'develop'], fx.repo);
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', 'develop', '--yes', '--json'], io), EXIT.ok, io.err.join(''));
		assert.ok(io.err.join('').includes('develop is checked out in the main checkout'), io.err.join(''));
		assert.strictEqual(json(io.out).branch?.name, 'feature/x');
		assert.ok(branchExists(fx.repo, 'develop'));
		assert.strictEqual(headOf(fx.repo), 'develop');
	});

	test('a protected positional with no current branch to finish is a usage error pointing to --into', async () => {
		git(['branch', 'develop', 'origin/main'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'develop', '--protect', 'develop', '--yes', '--json'], io), EXIT.usage);
		const { error } = JSON.parse(io.out.join('')) as { error: { message: string; code: string } };
		assert.strictEqual(error.code, 'usage');
		assert.ok(error.message.includes('"gsp post-pr <branch> --into develop"'), error.message);
		assert.ok(branchExists(fx.repo, 'develop'));
	});

	test('without origin/HEAD, "post-pr origin/main" is the old form too', async () => {
		mergedCurrentBranch('feature/x');
		git(['remote', 'set-head', 'origin', '--delete'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'origin/main', '--yes'], io), EXIT.ok, io.err.join(''));
		assert.ok(io.err.join('').includes('"gsp post-pr origin/main" is deprecated'), io.err.join(''));
		assert.strictEqual(headOf(fx.repo), 'main');
		assert.ok(!branchExists(fx.repo, 'feature/x'));
	});

	test('a branch nobody knows is a typo: usage error, with the close branches', async () => {
		git(['branch', 'feature/x'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'feture/x', '--no-github', '--json'], io), EXIT.usage);
		assert.deepStrictEqual(JSON.parse(io.out.join('')), {
			schema: 2,
			error: { message: 'No branch named "feture/x". Did you mean feature/x?', code: 'unknown-branch' },
		});

		const into = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'feature/x', '--into', 'nope', '--no-github', '--json'], into), EXIT.usage);
		assert.strictEqual((JSON.parse(into.out.join('')) as { error: { code: string } }).error.code, 'unknown-branch');
	});

	test('a branch merged into another remote branch hints at --into, never --force', async () => {
		git(['checkout', '-q', '-b', 'feature/x'], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\n', 'work');
		git(['push', '-q', 'origin', 'feature/x:develop'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'feature/x', '--no-github', '--json'], io), EXIT.notApplied, io.err.join(''));
		const report = json(io.out);
		assert.deepStrictEqual([report.branch?.reason, report.branch?.hint], ['needs-force', 'gsp post-pr feature/x --into develop --no-github --yes']);
	});

	test('unpushed commits on top of a merged branch: push them first', async () => {
		mergedCurrentBranch('feature/x');
		commitFile(fx.repo, 'y.txt', 'y\n', 'more work');
		git(['fetch', '-q', '--prune'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', '--no-github', '--json'], io), EXIT.notApplied, io.err.join(''));
		const report = json(io.out);
		assert.deepStrictEqual([report.branch?.reason, report.branch?.hint], ['needs-force', 'git push -u origin feature/x']);

		const text = createFakeIo(fx.repo);
		await runCli(['post-pr', '--no-github'], text);
		assert.ok(text.out.join('').includes('feature/x  not proven merged yet ('), text.out.join(''));
	});

	test('the default branch checked out nowhere is moved as a ref, with a reflog message', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');
		git(['checkout', '-q', '--detach'], fx.repo);

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json'], io), EXIT.ok, io.err.join(''));
		assert.strictEqual(json(io.out).defaultBranch.where, null);
		assert.strictEqual(tip('main'), tip('origin/main'));
		assert.strictEqual(git(['reflog', '-1', '--format=%gs', 'main'], fx.repo).trim(), 'gsp post-pr');
	});

	test('in a bare repository, continues in another worktree', async () => {
		const bare = path.join(fx.dir, 'bare.git');
		git(['clone', '-q', '--bare', fx.remote, bare], fx.dir);
		git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], bare);
		git(['fetch', '-q', 'origin'], bare);
		git(['remote', 'set-head', 'origin', 'main'], bare);
		const home = path.join(fx.dir, 'home');
		git(['worktree', 'add', '-q', home, 'main'], bare);
		const wt = path.join(fx.dir, 'wt-x');
		git(['worktree', 'add', '-q', '-b', 'feature/x', wt, 'origin/main'], bare);
		commitFile(wt, 'x.txt', 'x\n', 'work');
		git(['push', '-q', '-u', 'origin', 'feature/x'], wt);
		squashMergeOnRemote('feature/x');

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json', '--no-github'], io), EXIT.ok, io.err.join(''));
		const report = json(io.out);
		assert.strictEqual(report.branch?.result, 'deleted');
		assert.strictEqual(report.nextCwd, fs.realpathSync(home));
	});

	test('--into compares with another branch, which stays protected like the default one', async () => {
		git(['checkout', '-q', '-b', 'develop'], fx.repo);
		git(['push', '-q', '-u', 'origin', 'develop'], fx.repo);
		git(['checkout', '-q', '-b', 'feature/x'], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\n', 'work');
		git(['checkout', '-q', 'develop'], fx.repo);
		git(['merge', '-q', '--ff-only', 'feature/x'], fx.repo);
		git(['push', '-q', 'origin', 'develop'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'feature/x', '--into', 'develop', '--yes', '--json'], io), EXIT.ok, io.err.join(''));
		const report = json(io.out);
		assert.strictEqual(report.branch?.result, 'deleted');
		assert.strictEqual(report.defaultBranch.name, 'develop');
		assert.ok(branchExists(fx.repo, 'develop'));
		assert.ok(branchExists(fx.repo, 'main'));
	});

	test('when the fetch moves the default branch, nothing is deleted (Git 2.48+)', async function () {
		const [major, minor] = (/(\d+)\.(\d+)/.exec(git(['version'], fx.repo)) ?? []).slice(1).map(Number);
		if (major < 2 || (major === 2 && minor < 48)) {
			this.skip();
		}
		const wt = addFeatureWorktree('feature/x');
		makeGoneBranch(fx.repo, 'feature/old');
		squashMergeOnRemote('feature/x');
		// The merge is in both: only the change of default branch holds the deletions back.
		git(['push', '-q', 'origin', 'main:trunk'], path.join(fx.dir, 'merger'));
		git(['symbolic-ref', 'HEAD', 'refs/heads/trunk'], fx.remote);
		git(['config', 'remote.origin.followRemoteHEAD', 'always'], fx.repo);

		const io = createFakeIo(wt);
		assert.strictEqual(await runCli(['post-pr', '--yes', '--json'], io), EXIT.notApplied, io.err.join(''));
		const report = json(io.out);
		assert.deepStrictEqual([report.branch?.action, report.branch?.reason, report.branch?.hint], ['skip', 'plan-changed', 'gsp post-pr feature/x --dry-run']);
		assert.ok(report.clean.branches.every((branch) => branch.result === undefined));
		assert.strictEqual((report as PostPrDocument).next, 'gsp post-pr feature/x --dry-run');
		assert.ok(io.err.join('').includes('The default branch changed from origin/main to origin/trunk during the fetch, so nothing was deleted.'), io.err.join(''));
		assert.ok(fs.existsSync(wt));
		assert.ok(branchExists(fx.repo, 'feature/x') && branchExists(fx.repo, 'feature/old'));
	});

	/** What `gh pr merge --delete-branch` leaves: the branch merged on the remote and deleted there and locally, main checked out. */
	function mergeAndDeleteBranch(name: string): void {
		git(['checkout', '-q', '-b', name], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\n', 'work');
		git(['push', '-q', '-u', 'origin', name], fx.repo);
		squashMergeOnRemote(name);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['branch', '-q', '-D', name], fx.repo);
	}

	test('a branch that is already deleted: says so, updates main and cleans', async () => {
		mergeAndDeleteBranch('feature/x');
		makeGoneBranch(fx.repo, 'feature/old');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'feature/x', '--yes'], io), EXIT.ok, io.err.join(''));
		const out = io.out.join('');
		assert.ok(out.startsWith('feature/x is already deleted.\n'), out);
		assert.match(out, /^main: fast-forwarded to origin\/main /m);
		assert.ok(out.includes('Other branches: 1 deleted'), out);
		assert.strictEqual(tip('main'), tip('origin/main'));
		assert.ok(!branchExists(fx.repo, 'feature/old'));
	});

	test('a branch that is already deleted, in JSON', async () => {
		mergeAndDeleteBranch('feature/x');
		git(['fetch', '-q'], fx.repo);

		const plan = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'feature/x', '--json'], plan), EXIT.notApplied, plan.err.join(''));
		const planned = JSON.parse(plan.out.join('')) as PostPrDocument;
		assert.deepStrictEqual(planned.branch, { name: 'feature/x', action: 'gone' });
		assert.strictEqual(planned.defaultBranch.reason, 'not-applied');
		assert.strictEqual(planned.next, 'gsp post-pr feature/x --yes');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'feature/x', '--yes', '--json'], io), EXIT.ok, io.err.join(''));
		const report = JSON.parse(io.out.join('')) as PostPrDocument;
		assert.deepStrictEqual(report.branch, { name: 'feature/x', action: 'gone' });
		assert.strictEqual(report.next, null);
		assert.deepStrictEqual(report.worktree, { path: null, removed: false, switched: false });
		assert.strictEqual(report.defaultBranch.updated, true);
		assert.strictEqual(report.restore, null);
	});

	test('in a terminal, asks before deleting; refusing changes nothing', async () => {
		const wt = addFeatureWorktree('feature/x');
		squashMergeOnRemote('feature/x');

		const { prompter, calls } = createFakePrompter({ confirm: false });
		const io = { ...createFakeIo(wt, { interactive: true }), loadPrompter: async () => prompter };
		assert.strictEqual(await runCli(['post-pr'], io), EXIT.cancelled, io.err.join(''));
		assert.ok(calls.includes('confirm Finish'), calls.join('\n'));
		assert.ok(fs.existsSync(wt));
		assert.ok(branchExists(fx.repo, 'feature/x'));
	});
});
