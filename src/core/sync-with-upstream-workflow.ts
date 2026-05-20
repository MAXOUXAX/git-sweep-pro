import { runResumeFlow } from './sync-with-upstream-resume-flow';
import { runSyncFlow } from './sync-with-upstream-sync-flow';
import type { SyncWithUpstreamDeps } from './sync-with-upstream-state';

export type { SyncWithUpstreamDeps } from './sync-with-upstream-state';

export async function runSyncWithUpstreamWorkflow(deps: SyncWithUpstreamDeps): Promise<void> {
	await runSyncFlow(deps);
}

export async function runSyncWithUpstreamResumeWorkflow(deps: SyncWithUpstreamDeps): Promise<void> {
	await runResumeFlow(deps);
}
