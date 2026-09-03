import { getJobStoreMode } from "../config/env.mjs";
import { logger } from "../shared/logger.mjs";
import {
  appendClaimedJobEvent as appendClaimedMockJobEvent,
  appendJobEvent as appendMockJobEvent,
  claimJob as claimMockJob,
  findPendingJob as findPendingMockJob,
  renewLease as renewMockJobLease,
  updateClaimedJob as updateClaimedMockJob,
  updateJob as updateMockJob,
} from "./mock-job-store.mjs";
import {
  appendClaimedFirestoreJobEvent,
  appendFirestoreJobEvent,
  claimFirestoreJob,
  findPendingFirestoreJob,
  getFirestoreJobByIdentity,
  processPendingFirestoreClientCommands,
  processNextFirestoreClientCommand,
  renewFirestoreJobLease,
  updateClaimedFirestoreJob,
  updateFirestoreJob,
} from "./firestore-job-store.mjs";

export function createJobStore() {
  const mode = getJobStoreMode();

  logger.info("Job store selected.", { mode });

  if (mode === "firestore") {
    return {
      findPendingJob: findPendingFirestoreJob,
      getJobByIdentity: getFirestoreJobByIdentity,
      processClientCommands: processPendingFirestoreClientCommands,
      processNextClientCommand: processNextFirestoreClientCommand,
      claimJob: claimFirestoreJob,
      renewLease: renewFirestoreJobLease,
      updateClaimedJob: updateClaimedFirestoreJob,
      updateJob: updateFirestoreJob,
      appendClaimedJobEvent: appendClaimedFirestoreJobEvent,
      appendJobEvent: appendFirestoreJobEvent,
    };
  }

  return {
    findPendingJob: findPendingMockJob,
    claimJob: claimMockJob,
    renewLease: renewMockJobLease,
    updateClaimedJob: updateClaimedMockJob,
    updateJob: updateMockJob,
    appendClaimedJobEvent: appendClaimedMockJobEvent,
    appendJobEvent: appendMockJobEvent,
  };
}
