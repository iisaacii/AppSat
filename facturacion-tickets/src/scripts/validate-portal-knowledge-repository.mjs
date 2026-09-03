import assert from "node:assert/strict";
import {
  buildPortalKnowledgeDocumentId,
  shouldReadLocalPortalKnowledge,
  shouldUseSharedPortalKnowledge,
} from "../portals/portal-knowledge-repository.mjs";

const previousMode = process.env.PORTAL_KNOWLEDGE_STORE;

try {
  process.env.PORTAL_KNOWLEDGE_STORE = "local";
  assert.equal(shouldReadLocalPortalKnowledge(), true);
  assert.equal(shouldUseSharedPortalKnowledge(), false);

  process.env.PORTAL_KNOWLEDGE_STORE = "dual";
  assert.equal(shouldReadLocalPortalKnowledge(), true);
  assert.equal(shouldUseSharedPortalKnowledge(), true);

  process.env.PORTAL_KNOWLEDGE_STORE = "firestore";
  assert.equal(shouldReadLocalPortalKnowledge(), false);
  assert.equal(shouldUseSharedPortalKnowledge(), true);

  const idA = buildPortalKnowledgeDocumentId("SEM980701STA|7-eleven.com.mx|captcha_required");
  const idB = buildPortalKnowledgeDocumentId("SEM980701STA|7-eleven.com.mx|captcha_required");
  const idC = buildPortalKnowledgeDocumentId("SEM980701STA|7-eleven.com.mx|login_required");
  assert.equal(idA, idB);
  assert.notEqual(idA, idC);
  assert.match(idA, /^[a-f0-9]{40}$/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        modes: ["local", "dual", "firestore"],
        deterministicDocumentIds: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (previousMode === undefined) {
    delete process.env.PORTAL_KNOWLEDGE_STORE;
  } else {
    process.env.PORTAL_KNOWLEDGE_STORE = previousMode;
  }
}
