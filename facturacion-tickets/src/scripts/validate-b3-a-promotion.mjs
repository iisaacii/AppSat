import assert from "node:assert/strict";
import { chooseCandidateStatus, isReplayPromotionSuccess } from "../b3-to-a/b3-to-a-bridge.mjs";
import { waitForPortalLoadState } from "../portals/template-runner.mjs";

const completedWithXml = {
  ok: true,
  status: "completed",
  result: {
    xmlPath: "artifacts/cfdi.xml",
    pdfPath: "artifacts/cfdi.pdf",
  },
};
const completedWithoutXml = {
  ok: true,
  status: "completed",
  result: {
    pdfPath: "artifacts/cfdi.pdf",
  },
};
const failed = {
  ok: false,
  status: "failed",
  result: null,
};

assert.equal(isReplayPromotionSuccess(completedWithXml), true);
assert.equal(isReplayPromotionSuccess(completedWithoutXml), false);
assert.equal(chooseCandidateStatus("compiled", completedWithXml), "replay_passed_1");
assert.equal(chooseCandidateStatus("replay_passed_1", completedWithXml), "active_lab");
assert.equal(chooseCandidateStatus("replay_passed_1", failed), "compiled");

const settledFromEvidence = await waitForPortalLoadState(
  {
    async waitForLoadState() {
      throw new Error("Timeout 10000ms exceeded");
    },
    async evaluate() {
      return {
        readyState: "complete",
        hasBody: true,
        url: "https://example.com/facturacion",
      };
    },
  },
  "networkidle",
  10,
);

assert.equal(settledFromEvidence.settledWithEvidence, true);

await assert.rejects(
  () =>
    waitForPortalLoadState(
      {
        async waitForLoadState() {
          throw new Error("Timeout 10000ms exceeded");
        },
        async evaluate() {
          return {
            readyState: "loading",
            hasBody: true,
            url: "https://example.com/facturacion",
          };
        },
      },
      "domcontentloaded",
      10,
    ),
  /Timeout/,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      firstReplay: "replay_passed_1",
      secondReplay: "active_lab",
      incompleteReplay: "not_promoted",
      stableLoadEvidence: true,
    },
    null,
    2,
  ),
);
