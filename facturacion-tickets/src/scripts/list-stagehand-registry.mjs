import { listStagehandPortalStates } from "../stagehand-lab/registry.mjs";

const states = await listStagehandPortalStates();

console.log(
  JSON.stringify(
    states.map((state) => ({
      key: state.key,
      rfcEmisor: state.rfcEmisor,
      portalHost: state.portalHost,
      portalUrl: state.portalUrl,
      status: state.status,
      successCount: state.successCount ?? 0,
      failureCount: state.failureCount ?? 0,
      consecutiveSuccesses: state.consecutiveSuccesses ?? 0,
      lastSuccessAt: state.lastSuccessAt ?? null,
      lastFailureAt: state.lastFailureAt ?? null,
      lastFailureReason: state.lastFailureReason ?? null,
      cacheActionCount: state.cache?.actions?.length ?? 0,
      model: state.model ?? null,
    })),
    null,
    2,
  ),
);
