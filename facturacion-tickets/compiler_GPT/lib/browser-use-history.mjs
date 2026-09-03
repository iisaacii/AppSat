import { readFile } from "node:fs/promises";

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function getHistoryPath(candidateDocument, explicitHistoryPath = null) {
  return (
    explicitHistoryPath ??
    candidateDocument?.source?.historyPath ??
    candidateDocument?.template?.b3Learning?.historyPath ??
    null
  );
}

export function getB3Actions(candidateDocument, historyDocument = null) {
  const learnedActions = candidateDocument?.template?.b3Learning?.actions;

  if (Array.isArray(learnedActions) && learnedActions.length) {
    return learnedActions;
  }

  return extractActionsFromHistory(historyDocument);
}

export function buildElementMapsByStep(historyDocument) {
  const maps = new Map();

  for (const entry of historyDocument?.history ?? []) {
    const stepNumber = entry?.metadata?.step_number;

    if (!Number.isFinite(Number(stepNumber))) {
      continue;
    }

    const elements = parseBrowserStateElements(entry.state_message ?? "");
    const byIndex = new Map(elements.map((element) => [element.index, element]));
    maps.set(Number(stepNumber), {
      elements,
      byIndex,
      url: entry?.state?.url ?? null,
      title: entry?.state?.title ?? null,
    });
  }

  return maps;
}

export function parseBrowserStateElements(stateMessage) {
  const startIndex = stateMessage.indexOf("Interactive elements:");

  if (startIndex === -1) {
    return [];
  }

  const endMarkers = ["Current screenshot:", "</browser_state>"];
  const endIndex = endMarkers
    .map((marker) => stateMessage.indexOf(marker, startIndex))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];
  const raw = stateMessage.slice(startIndex, endIndex === undefined ? undefined : endIndex);
  const lines = raw.split(/\r?\n/);
  const elements = [];
  const recentText = [];
  let currentElement = null;

  for (const line of lines) {
    const element = parseElementLine(line, recentText);

    if (element) {
      elements.push(element);
      currentElement = element;
      recentText.length = 0;
      continue;
    }

    const text = cleanTextLine(line);

    if (!text) {
      continue;
    }

    if (currentElement && /^\s/.test(line)) {
      currentElement.text = joinText(currentElement.text, text);
    }

    recentText.push(text);

    if (recentText.length > 6) {
      recentText.shift();
    }
  }

  return elements;
}

function parseElementLine(line, recentText) {
  const match = line.match(/(?:\|SHADOW\(open\)\|)?\*?\[(\d+)\]<([A-Za-z][A-Za-z0-9:-]*)\s*([^>]*)>/);

  if (!match) {
    return null;
  }

  const [, index, tag, attrText] = match;
  const attrs = parseKnownAttributes(attrText ?? "");

  return {
    index: Number(index),
    tag: tag.toLowerCase(),
    attrs,
    raw: line.trim(),
    text: "",
    beforeText: recentText.slice(-4).join(" "),
    inShadow: line.includes("|SHADOW(open)|"),
  };
}

function parseKnownAttributes(attrText) {
  const keys = [
    "id",
    "name",
    "type",
    "role",
    "placeholder",
    "aria-label",
    "alt",
    "value",
    "maxlength",
    "minlength",
    "required",
    "checked",
    "expanded",
  ];
  const attrs = {};

  for (const key of keys) {
    const value = extractAttribute(attrText, key);

    if (value !== null) {
      attrs[key] = value;
    }
  }

  return attrs;
}

function extractAttribute(attrText, key) {
  const escaped = key.replaceAll("-", "\\-");
  const match = attrText.match(new RegExp(`(?:^|\\s)${escaped}=([^=]*?)(?=\\s+[A-Za-z_:][-A-Za-z0-9_:]*=|\\s*/?$|$)`));

  if (!match) {
    return null;
  }

  return match[1].replace(/\s+\/$/, "").trim();
}

function cleanTextLine(line) {
  return String(line ?? "")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\|?SHADOW\(open\)\|?/, "")
    .trim();
}

function joinText(left, right) {
  return [left, right].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function extractActionsFromHistory(historyDocument) {
  const actions = [];

  for (const entry of historyDocument?.history ?? []) {
    const step = Number(entry?.metadata?.step_number);
    const rawActions = entry?.model_output?.action;
    const actionList = Array.isArray(rawActions) ? rawActions : [rawActions].filter(Boolean);

    for (const rawAction of actionList) {
      if (!rawAction || typeof rawAction !== "object") {
        continue;
      }

      const type = Object.keys(rawAction)[0];
      const payload = rawAction[type] ?? {};
      actions.push({
        step,
        urlBefore: entry?.state?.url ?? null,
        titleBefore: entry?.state?.title ?? null,
        ...normalizeRawAction(type, payload),
      });
    }
  }

  return actions;
}

function normalizeRawAction(type, payload) {
  if (type === "navigate") {
    return {
      type: "goto",
      url: payload.url,
      sourceAction: "browser-use.navigate",
    };
  }

  if (type === "input") {
    return {
      type: "fill",
      browserUseIndex: payload.index,
      rawTextLength: String(payload.text ?? "").length,
      sourceAction: "browser-use.input",
      stableSelectorRequired: true,
    };
  }

  if (type === "select_dropdown") {
    return {
      type: "select",
      browserUseIndex: payload.index,
      selectedTextHint: payload.text,
      sourceAction: "browser-use.select_dropdown",
      stableSelectorRequired: true,
    };
  }

  if (type === "click") {
    return {
      type: "click",
      browserUseIndex: payload.index,
      sourceAction: "browser-use.click",
      stableSelectorRequired: true,
    };
  }

  if (type === "wait") {
    return {
      type: "waitForLoadState",
      seconds: payload.seconds,
      sourceAction: "browser-use.wait",
    };
  }

  if (type === "done") {
    return {
      type: "done",
      success: payload.success,
      status: payload.data?.status,
      reason: payload.data?.reason,
      sourceAction: "browser-use.done",
    };
  }

  return {
    type,
    sourceAction: `browser-use.${type}`,
    stableSelectorRequired: true,
  };
}
