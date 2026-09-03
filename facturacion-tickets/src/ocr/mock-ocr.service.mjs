export async function extractTicketData(ticketFileUrl) {
  await sleep(500);
  const sourceType = ticketFileUrl.startsWith("http") ? "storage_image" : "mock";

  if (ticketFileUrl.includes("unknown")) {
    return {
      sourceType,
      rfcEmisor: "XXX010101XXX",
      folio: "UNKNOWN-001",
      fecha: "2026-05-12",
      monto: 199.99,
      ocrCandidates: {
        rfc: ["XXX010101XXX"],
        folioVenta: "UNKNOWN-001",
        ticketId: "UNKNOWN-001",
        fecha: "2026-05-12",
        monto: 199.99,
      },
    };
  }

  return {
    sourceType,
    rfcEmisor: "CCO8605231N4",
    folio: "A123456789",
    fecha: "2026-05-12",
    monto: 128.5,
    ocrCandidates: {
      rfc: ["CCO8605231N4"],
      folioVenta: "A123456789",
      ticketId: "MOCKTICKET001",
      fecha: "2026-05-12",
      monto: 128.5,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
