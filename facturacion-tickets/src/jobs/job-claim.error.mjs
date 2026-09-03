export class JobClaimLostError extends Error {
  constructor(jobId, message = "El worker ya no posee el claim del job") {
    super(`${message}: ${jobId}`);
    this.name = "JobClaimLostError";
    this.code = "job_claim_lost";
    this.jobId = jobId;
  }
}

export function isJobClaimLostError(error) {
  return error?.code === "job_claim_lost" || error instanceof JobClaimLostError;
}
