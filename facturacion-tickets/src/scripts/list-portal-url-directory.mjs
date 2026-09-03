import {
  loadPortalUrlDirectory,
  loadPortalUrlDirectoryHashmap,
  normalizePortalUrlHashmapEntries,
  validatePortalUrlDirectory,
  validatePortalUrlDirectoryHashmap,
} from "../portals/portal-url-directory.mjs";

const entries = await loadPortalUrlDirectory();
const hashmap = await loadPortalUrlDirectoryHashmap();
const validation = validatePortalUrlDirectory(entries);
const hashmapValidation = validatePortalUrlDirectoryHashmap(hashmap);
const hashmapEntries = normalizePortalUrlHashmapEntries(hashmap);

console.log(
  JSON.stringify(
    {
      validation,
      hashmapValidation,
      count: entries.length,
      hashmapCount: Object.keys(hashmap).length,
      hashmapUsableCount: hashmapEntries.length,
      entries: entries.map((entry) => ({
        rfcEmisor: entry.rfcEmisor ?? null,
        name: entry.name ?? null,
        url: entry.url ?? null,
        confidence: entry.confidence ?? null,
        source: entry.source ?? null,
      })),
    },
    null,
    2,
  ),
);
