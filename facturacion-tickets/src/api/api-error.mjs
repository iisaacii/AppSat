export class BillingApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "BillingApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code, message, details = undefined) {
  return new BillingApiError(400, code, message, details);
}

export function unauthorized(message = "Credencial de acceso ausente o invalida") {
  return new BillingApiError(401, "unauthorized", message);
}

export function forbidden(message = "No tienes permiso para realizar esta accion") {
  return new BillingApiError(403, "forbidden", message);
}

export function notFound(message = "Recurso no encontrado") {
  return new BillingApiError(404, "not_found", message);
}

export function conflict(code, message, details = undefined) {
  return new BillingApiError(409, code, message, details);
}

export function unprocessable(code, message, details = undefined) {
  return new BillingApiError(422, code, message, details);
}
