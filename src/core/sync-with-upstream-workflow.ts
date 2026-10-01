/** Public entry points of the Sync With Upstream feature. */
export { runResumeFlow as runSyncWithUpstreamResumeWorkflow } from './sync-with-upstream-resume-flow';
export { runSyncFlow as runSyncWithUpstreamWorkflow } from './sync-with-upstream-sync-flow';
export type { SyncWithUpstreamDeps } from './sync-with-upstream-state';
