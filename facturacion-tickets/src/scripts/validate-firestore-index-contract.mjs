import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const indexesPath = fileURLToPath(
  new URL("../../../firestore.indexes.json", import.meta.url),
);
const config = JSON.parse(await readFile(indexesPath, "utf8"));

const compositeRequirements = [
  {
    collectionGroup: "facturaJobs",
    fields: [
      ["status", "ASCENDING"],
      ["workflowStage", "ASCENDING"],
    ],
    reason: "worker lane discovery",
  },
  {
    collectionGroup: "facturaJobs",
    fields: [
      ["rfcReceptor", "ASCENDING"],
      ["createdAt", "DESCENDING"],
    ],
    reason: "existing CFDI lookup",
  },
];

const fieldRequirements = [
  ["facturaJobs", "id", "ASCENDING", "COLLECTION_GROUP", "legacy job path recovery"],
  ["facturaJobs", "status", "ASCENDING", "COLLECTION_GROUP", "worker job discovery"],
  ["facturaJobs", "updatedAt", "ASCENDING", "COLLECTION_GROUP", "retention preview"],
  ["facturaJobs", "updatedAt", "DESCENDING", "COLLECTION", "per-user support queries"],
  ["billingJobCommands", "status", "ASCENDING", "COLLECTION_GROUP", "pending command discovery"],
  ["billingJobCommands", "requestedAt", "ASCENDING", "COLLECTION_GROUP", "command retention preview"],
];

function hasCompositeIndex(requirement) {
  return (config.indexes ?? []).some((index) => {
    if (
      index.collectionGroup !== requirement.collectionGroup ||
      index.queryScope !== "COLLECTION_GROUP"
    ) {
      return false;
    }

    const fields = index.fields ?? [];
    return (
      fields.length === requirement.fields.length &&
      requirement.fields.every(([fieldPath, order], position) => {
        const actual = fields[position];
        return actual?.fieldPath === fieldPath && actual?.order === order;
      })
    );
  });
}

function hasFieldOverride(collectionGroup, fieldPath, order, queryScope) {
  return (config.fieldOverrides ?? []).some(
    (override) =>
      override.collectionGroup === collectionGroup &&
      override.fieldPath === fieldPath &&
      (override.indexes ?? []).some(
        (index) => index.queryScope === queryScope && index.order === order,
      ),
  );
}

for (const requirement of compositeRequirements) {
  assert.ok(
    hasCompositeIndex(requirement),
    `Missing composite index for ${requirement.collectionGroup}: ${requirement.fields
      .map(([fieldPath, order]) => `${fieldPath} ${order}`)
      .join(", ")} (${requirement.reason})`,
  );
}

for (const [collectionGroup, fieldPath, order, queryScope, reason] of fieldRequirements) {
  assert.ok(
    hasFieldOverride(collectionGroup, fieldPath, order, queryScope),
    `Missing ${queryScope} index for ${collectionGroup}.${fieldPath} ${order} (${reason})`,
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      file: indexesPath,
      compositeIndexes: compositeRequirements.map(({ collectionGroup, fields, reason }) => ({
        collectionGroup,
        fields: fields.map(([fieldPath, order]) => ({ fieldPath, order })),
        reason,
      })),
      fieldOverrides: fieldRequirements.map(([collectionGroup, fieldPath, order, queryScope, reason]) => ({
        collectionGroup,
        fieldPath,
        order,
        queryScope,
        reason,
      })),
    },
    null,
    2,
  ),
);
