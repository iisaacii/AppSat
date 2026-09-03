import { getOcrEngine } from "../config/env.mjs";
import { logger } from "../shared/logger.mjs";
import { extractTicketData as extractWithGoogleVision } from "./google-vision-ocr.service.mjs";
import { extractTicketData as extractWithMock } from "./mock-ocr.service.mjs";

export async function extractTicketData(ticketFileUrl, context = {}) {
  const engine = getOcrEngine();
  logger.info("OCR engine selected.", { engine });

  if (engine === "google_vision") {
    return extractWithGoogleVision(ticketFileUrl, context);
  }

  return extractWithMock(ticketFileUrl, context);
}
