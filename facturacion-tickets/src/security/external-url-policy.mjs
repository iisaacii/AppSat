import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "host.docker.internal",
  "gateway.docker.internal",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

export class UnsafeExternalUrlError extends Error {
  constructor(value, reason) {
    super(`URL externa bloqueada (${reason}): ${String(value ?? "")}`);
    this.name = "UnsafeExternalUrlError";
    this.code = "unsafe_external_url";
    this.reason = reason;
    this.url = String(value ?? "");
  }
}

export function validateExternalUrlStructure(value, options = {}) {
  const text = String(value ?? "").trim();
  if (!text || text.length > (options.maxLength ?? 4096)) {
    throw new UnsafeExternalUrlError(value, "missing_or_too_long");
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new UnsafeExternalUrlError(value, "invalid_url");
  }

  if (url.protocol === "file:") {
    return validateFileUrl(url, options);
  }
  if (!new Set(options.protocols ?? ["https:", "http:"]).has(url.protocol)) {
    throw new UnsafeExternalUrlError(value, "protocol_not_allowed");
  }
  if (url.username || url.password) {
    throw new UnsafeExternalUrlError(value, "embedded_credentials");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isBlockedHostname(hostname, options)) {
    throw new UnsafeExternalUrlError(value, "hostname_not_allowed");
  }
  if (isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    throw new UnsafeExternalUrlError(value, "private_or_reserved_ip");
  }

  url.hostname = hostname;
  return url;
}

export async function assertSafeExternalUrl(value, options = {}) {
  const url = validateExternalUrlStructure(value, options);
  if (url.protocol === "file:") return url;

  const hostname = normalizeHostname(url.hostname);
  if (!isIP(hostname)) {
    let addresses;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new UnsafeExternalUrlError(value, `dns_lookup_failed:${error.code ?? "unknown"}`);
    }
    if (!addresses.length || addresses.some((entry) => isPrivateOrReservedIp(entry.address))) {
      throw new UnsafeExternalUrlError(value, "dns_resolved_to_private_or_reserved_ip");
    }
  }
  return url;
}

export function assertTrustedTicketFileUrl(value, { uid, bucketName }) {
  const url = validateExternalUrlStructure(value, { protocols: ["https:"] });
  if (url.hostname !== "firebasestorage.googleapis.com") {
    throw new UnsafeExternalUrlError(value, "ticket_host_not_firebase_storage");
  }

  const prefix = `/v0/b/${bucketName}/o/`;
  if (!url.pathname.startsWith(prefix)) {
    throw new UnsafeExternalUrlError(value, "ticket_bucket_mismatch");
  }

  let objectPath;
  try {
    objectPath = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    throw new UnsafeExternalUrlError(value, "ticket_path_encoding_invalid");
  }
  const allowedPrefixes = [
    `billing-lab/tickets/${uid}/`,
    `billing-api/tickets/${uid}/`,
  ];
  const expectedPrefix = allowedPrefixes.find((prefix) => objectPath.startsWith(prefix));
  if (!uid || !expectedPrefix || objectPath.slice(expectedPrefix.length).includes("/")) {
    throw new UnsafeExternalUrlError(value, "ticket_owner_path_mismatch");
  }
  if (url.searchParams.get("alt") !== "media") {
    throw new UnsafeExternalUrlError(value, "ticket_download_mode_invalid");
  }
  return url;
}

export async function downloadExternalResource(value, options = {}) {
  let current = await assertSafeExternalUrl(value, options);
  const maxRedirects = options.maxRedirects ?? 4;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30000;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: options.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === maxRedirects) {
        throw new UnsafeExternalUrlError(current.href, "redirect_limit_or_location_missing");
      }
      current = await assertSafeExternalUrl(new URL(location, current).href, options);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Descarga externa fallo: HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Descarga externa excede ${maxBytes} bytes`);
    }

    const buffer = await readResponseWithLimit(response, maxBytes);
    return {
      buffer,
      contentType: response.headers.get("content-type") ?? "",
      finalUrl: current.href,
      headers: response.headers,
      status: response.status,
    };
  }

  throw new UnsafeExternalUrlError(value, "redirect_limit_exceeded");
}

export async function installSafePageNetworkGuard(page, options = {}) {
  const cache = new Map();
  const cacheTtlMs = options.cacheTtlMs ?? 30000;

  await page.route("**/*", async (route) => {
    const request = route.request();
    const value = request.url();
    if (/^(about:|data:|blob:|chrome:)/i.test(value)) {
      await route.continue();
      return;
    }

    try {
      const structured = validateExternalUrlStructure(value, options);
      const cacheKey = structured.hostname;
      const cachedAt = cache.get(cacheKey) ?? 0;
      if (request.isNavigationRequest() || Date.now() - cachedAt > cacheTtlMs) {
        await assertSafeExternalUrl(structured.href, options);
        cache.set(cacheKey, Date.now());
      }
      await route.continue();
    } catch (error) {
      options.onBlocked?.({
        url: value,
        reason: error?.reason ?? error?.message ?? "unsafe_external_url",
        resourceType: request.resourceType(),
      });
      await route.abort("blockedbyclient");
    }
  });
}

export function isPrivateOrReservedIp(value) {
  const address = String(value ?? "").toLowerCase().split("%")[0];
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;

  const mapped = address.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89ab]/.test(address) ||
    address.startsWith("ff") ||
    address.startsWith("2001:db8:")
  );
}

function validateFileUrl(url, options) {
  if (!options.allowFile) {
    throw new UnsafeExternalUrlError(url.href, "file_protocol_not_allowed");
  }
  const filePath = resolve(fileURLToPath(url));
  const roots = (options.allowedFileRoots ?? []).map((root) => resolve(root));
  if (!roots.length || !roots.some((root) => isWithin(root, filePath))) {
    throw new UnsafeExternalUrlError(url.href, "file_outside_allowed_roots");
  }
  return url;
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function normalizeHostname(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isBlockedHostname(hostname, options) {
  if (blockedHostnames.has(hostname)) return true;
  if (hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (!options.allowReservedTestHost && (hostname.endsWith(".test") || hostname.endsWith(".invalid"))) return true;
  return false;
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

async function readResponseWithLimit(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response_too_large");
      throw new Error(`Descarga externa excede ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
