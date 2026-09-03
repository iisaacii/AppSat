import Busboy from "busboy";
import {
  normalizeTaxProfile,
  validateTaxProfile,
} from "../contracts/factura-job-contract.mjs";
import { BillingApiError } from "./api-error.mjs";

const allowedFields = new Set(["taxProfile", "rfcReceptor"]);
const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

export async function readAutonomousBillingRequest(
  request,
  { ticketLimitBytes = 10 * 1024 * 1024, fieldLimitBytes = 128 * 1024 } = {},
) {
  const contentType = clean(request.headers["content-type"]);
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new BillingApiError(
      415,
      "unsupported_media_type",
      "Se requiere multipart/form-data con ticket y taxProfile",
    );
  }

  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: {
          files: 1,
          fileSize: ticketLimitBytes,
          fields: 2,
          fieldSize: fieldLimitBytes,
          parts: 3,
        },
      });
    } catch (error) {
      reject(new BillingApiError(400, "invalid_multipart", "El formulario multipart no es valido"));
      return;
    }

    const fields = {};
    const chunks = [];
    let ticket = null;
    let parseError = null;

    parser.on("file", (name, stream, info) => {
      if (name !== "ticket" || ticket) {
        parseError ??= new BillingApiError(400, "invalid_ticket_file", "Incluye un solo archivo llamado ticket");
        stream.resume();
        return;
      }

      const mimeType = clean(info.mimeType).toLowerCase();
      if (!allowedMimeTypes.has(mimeType)) {
        parseError ??= new BillingApiError(
          415,
          "unsupported_ticket_type",
          "El ticket debe ser JPG, PNG, WebP o AVIF",
        );
      }
      ticket = {
        filename: clean(info.filename) || "ticket",
        mimeType,
        truncated: false,
      };
      stream.on("limit", () => {
        ticket.truncated = true;
        parseError ??= new BillingApiError(413, "ticket_too_large", "La imagen del ticket excede el limite permitido");
      });
      stream.on("data", (chunk) => chunks.push(chunk));
    });

    parser.on("field", (name, value) => {
      if (!allowedFields.has(name)) {
        parseError ??= new BillingApiError(400, "unexpected_multipart_field", `Campo no permitido: ${name}`);
        return;
      }
      fields[name] = value;
    });
    parser.on("filesLimit", () => {
      parseError ??= new BillingApiError(400, "too_many_ticket_files", "Incluye un solo ticket");
    });
    parser.on("fieldsLimit", () => {
      parseError ??= new BillingApiError(400, "too_many_fields", "El formulario contiene demasiados campos");
    });
    parser.on("partsLimit", () => {
      parseError ??= new BillingApiError(400, "too_many_parts", "El formulario contiene demasiadas partes");
    });
    parser.on("error", () => {
      reject(new BillingApiError(400, "invalid_multipart", "No fue posible leer el formulario multipart"));
    });
    parser.on("close", () => {
      if (parseError) {
        reject(parseError);
        return;
      }
      if (!ticket || !chunks.length) {
        reject(new BillingApiError(400, "missing_ticket", "Falta el archivo ticket"));
        return;
      }
      const ticketBuffer = Buffer.concat(chunks);
      if (!matchesImageSignature(ticketBuffer, ticket.mimeType)) {
        reject(new BillingApiError(
          415,
          "invalid_ticket_image",
          "El contenido del archivo no coincide con el tipo de imagen declarado",
        ));
        return;
      }

      let taxProfile;
      try {
        taxProfile = JSON.parse(fields.taxProfile ?? "");
      } catch {
        reject(new BillingApiError(400, "invalid_tax_profile_json", "taxProfile debe contener JSON valido"));
        return;
      }
      if (!taxProfile || typeof taxProfile !== "object" || Array.isArray(taxProfile)) {
        reject(new BillingApiError(400, "invalid_tax_profile", "taxProfile debe ser un objeto JSON"));
        return;
      }

      const normalizedTaxProfile = normalizeTaxProfile(taxProfile);
      const taxProfileErrors = validateTaxProfile(normalizedTaxProfile);
      if (taxProfileErrors.length) {
        reject(new BillingApiError(
          422,
          "tax_profile_incomplete",
          "El perfil fiscal enviado esta incompleto o no es valido",
          taxProfileErrors,
        ));
        return;
      }
      const requestedRfc = clean(fields.rfcReceptor).toUpperCase();
      if (requestedRfc && requestedRfc !== normalizedTaxProfile.rfc) {
        reject(new BillingApiError(
          422,
          "rfc_receptor_mismatch",
          "El RFC receptor no coincide con el perfil fiscal enviado",
        ));
        return;
      }

      resolve({
        ticket: {
          ...ticket,
          buffer: ticketBuffer,
        },
        taxProfile: normalizedTaxProfile,
        rfcReceptor: requestedRfc || null,
      });
    });

    request.pipe(parser);
  });
}

function matchesImageSignature(buffer, mimeType) {
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/webp") {
    return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "image/avif") {
    const brand = buffer.length >= 12 ? buffer.subarray(4, 12).toString("ascii") : "";
    return brand.startsWith("ftyp") && /avif|avis/.test(buffer.subarray(8, 32).toString("ascii"));
  }
  return false;
}

function clean(value) {
  return String(value ?? "").trim();
}
