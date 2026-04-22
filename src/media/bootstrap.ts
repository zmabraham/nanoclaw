import { onStartup } from '../lifecycle.js';
import { logger } from '../logger.js';
import { auditEnvAllowlist } from '../env.js';
import { MEDIA_PIPELINE_ENABLED } from '../config.js';

onStartup(async () => {
  auditEnvAllowlist();
  logger.info(
    { pipelineEnabled: MEDIA_PIPELINE_ENABLED === '1' },
    `media ingestion path: ${MEDIA_PIPELINE_ENABLED === '1' ? 'pipeline' : 'legacy'}`,
  );
  // NOTE: The rotation startup sweep is wired in src/index.ts (Task 14 Step 2
  // item 9) — immediately after `loadState()`, iterating `registeredGroups`
  // and calling `rotateAttachments`. Keeping the iteration in index.ts avoids
  // a circular dependency. Do not duplicate the sweep here.
});
