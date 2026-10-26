import * as assert from 'assert';
import { identifyForge, parseRemoteUrl, parseSshHostname, sameRepository, type RunSsh } from '../../core/forge';
import type { RunGit } from '../../core/git-command';
import type { RunGh } from '../../core/github-signal';

/** A `git` whose `remote get-url` prints `used`, as after `insteadOf`. */
const gitUsing =
	(used: string): RunGit =>
	async () => ({ stdout: `${used}\n`, stderr: '' });

suite('forge', () => {
	test('reads the host, owner and name of every URL form, and knows a local path', () => {
		assert.deepStrictEqual(parseRemoteUrl('https://github.com/acme/widgets.git'), { local: false, host: 'github.com', ssh: false, path: 'acme/widgets', owner: 'acme', name: 'widgets' });
		assert.deepStrictEqual(parseRemoteUrl('git@Work:acme/widgets.git'), { local: false, host: 'work', ssh: true, path: 'acme/widgets', owner: 'acme', name: 'widgets' });
		assert.deepStrictEqual(parseRemoteUrl('ssh://git@ssh.github.com:443/acme/widgets/'), {
			local: false,
			host: 'ssh.github.com',
			ssh: true,
			path: 'acme/widgets',
			owner: 'acme',
			name: 'widgets',
		});
		assert.deepStrictEqual(parseRemoteUrl('https://git.example.com/group/sub/widgets'), { local: false, host: 'git.example.com', ssh: false, path: 'group/sub/widgets', owner: 'sub', name: 'widgets' });
		assert.deepStrictEqual(parseRemoteUrl('https://git.example.com/widgets.git'), { local: false, host: 'git.example.com', ssh: false, path: 'widgets' });
		for (const local of ['/srv/git/widgets.git', '../widgets', 'file:///srv/git/widgets.git', 'C:\\repos\\widgets', 'widgets']) {
			assert.deepStrictEqual(parseRemoteUrl(local), { local: true }, local);
		}
	});

	test('two URLs are the same repository whatever the protocol, the case, a .git suffix or an SSH alias', async () => {
		const ssh: RunSsh = async (args) => ({ stdout: `hostname ${args[1] === 'work' ? 'github.com' : args[1]}\n`, stderr: '' });
		const same = (a: string, b: string) => sameRepository(ssh, a, b);
		assert.ok(await same('https://github.com/acme/widgets', 'git@github.com:acme/widgets.git'));
		assert.ok(await same('https://GitHub.com/Acme/Widgets.git', 'ssh://git@ssh.github.com:443/acme/widgets/'));
		assert.ok(await same('https://github.com/acme/widgets', 'git@work:acme/widgets.git'));
		assert.ok(await same('/srv/git/widgets.git', '/srv/git/widgets.git'));
		assert.ok(!(await same('https://github.com/acme/widgets', 'git@github.com:acme/widgets-fork.git')));
		assert.ok(!(await same('https://github.com/acme/widgets', 'git@github.com:other/widgets.git')));
		assert.ok(!(await same('https://github.com/acme/widgets', 'git@gitlab.com:acme/widgets.git')));
		assert.ok(!(await same('https://git.example.com/group/sub/widgets', 'git@git.example.com:other/sub/widgets.git')));
		assert.ok(!(await same('https://github.com/acme/widgets', '/srv/git/widgets.git')));
		assert.ok(!(await same('/srv/git/widgets.git', '/srv/git/other.git')));
	});

	test('reads the host name ssh -G resolved an alias to', () => {
		assert.strictEqual(parseSshHostname('user git\nhostname GitHub.com\nport 22\n'), 'github.com');
		assert.strictEqual(parseSshHostname('user git\nport 22\n'), undefined);
	});

	test('a remote is on GitHub when either URL is; elsewhere only when both are known to be', async () => {
		const ssh: RunSsh = async (args) => ({ stdout: `hostname ${args[1] === 'work' ? 'github.com' : args[1]}\n`, stderr: '' });
		const failingSsh: RunSsh = async () => {
			throw new Error('ssh: timed out');
		};
		assert.deepStrictEqual(await identifyForge({ git: gitUsing('/srv/mirror.git'), ssh }, 'origin', 'git@work:acme/widgets.git'), {
			kind: 'github',
			repo: { host: 'github.com', owner: 'acme', name: 'widgets' },
		});
		// Unresolved, the alias stays the host, which nothing identifies.
		assert.deepStrictEqual(await identifyForge({ git: gitUsing('/srv/mirror.git'), ssh: failingSsh }, 'origin', 'git@work:acme/widgets.git'), {
			kind: 'unknown',
			host: 'work',
		});
		// insteadOf rewrote a short name to GitHub.
		assert.deepStrictEqual(await identifyForge({ git: gitUsing('git@github.com:acme/widgets.git') }, 'origin', 'gh:acme/widgets'), {
			kind: 'github',
			repo: { host: 'github.com', owner: 'acme', name: 'widgets' },
		});
		assert.deepStrictEqual(await identifyForge({ git: gitUsing('git@ssh.github.com:acme/widgets.git') }, 'origin', undefined), {
			kind: 'github',
			repo: { host: 'github.com', owner: 'acme', name: 'widgets' },
		});
		assert.deepStrictEqual(await identifyForge({ git: gitUsing('https://bitbucket.org/acme/widgets.git') }, 'origin', '/srv/git/widgets.git'), { kind: 'other' });
		assert.deepStrictEqual(await identifyForge({ git: gitUsing('https://git.example.com/acme/widgets.git') }, 'origin', undefined, 'none'), { kind: 'other' });
		// A GitHub host without owner and name can't be asked about.
		assert.deepStrictEqual(await identifyForge({ git: gitUsing('https://github.com/widgets') }, 'origin', undefined), { kind: 'unknown', host: 'github.com' });
	});

	test('a host gh is logged in to is a GitHub server; gh failing tells nothing', async () => {
		const gh =
			(loggedIn: boolean): RunGh =>
			async () => ({ stdout: JSON.stringify({ hosts: { 'git.example.com': [{ state: loggedIn ? 'success' : 'error' }] } }), stderr: '' });
		const failing: RunGh = async () => {
			throw Object.assign(new Error('gh'), { code: 'ENOENT' });
		};
		const url = 'https://git.example.com/acme/widgets.git';
		assert.deepStrictEqual(await identifyForge({ git: gitUsing(url), gh: gh(true) }, 'origin', url), {
			kind: 'github',
			repo: { host: 'git.example.com', owner: 'acme', name: 'widgets' },
		});
		assert.deepStrictEqual(await identifyForge({ git: gitUsing(url), gh: gh(false) }, 'origin', url), { kind: 'unknown', host: 'git.example.com' });
		assert.deepStrictEqual(await identifyForge({ git: gitUsing(url), gh: failing }, 'origin', url), { kind: 'unknown', host: 'git.example.com' });
	});
});
