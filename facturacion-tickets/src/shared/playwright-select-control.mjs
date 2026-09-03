import { SAT_CFDI_CATALOG_POLICY } from "../fiscal/sat-cfdi-catalog.mjs";

const customOptionSelector = [
  ".cdk-overlay-pane mat-option",
  ".cdk-overlay-pane [role=\"option\"]",
  ".cdk-overlay-pane .mat-mdc-option",
  ".cdk-overlay-pane .mat-option",
  "[role=\"listbox\"] [role=\"option\"]",
  "mat-option",
  "[role=\"option\"]",
].join(", ");

export async function selectBestOption(page, locator, rawValue, step = {}) {
  const expected = String(rawValue ?? "").trim();
  const timeout = step.timeoutMs ?? 10000;

  if (!expected) {
    return;
  }

  const target = locator.first();
  await target.waitFor({ state: "attached", timeout });
  const deadline = Date.now() + timeout;
  let lastError = null;

  while (Date.now() < deadline) {
    const isNativeSelect = await isHtmlSelect(target).catch((error) => {
      lastError = error;
      return false;
    });

    if (isNativeSelect) {
      const resolvedValue = await resolveNativeSelectOptionValue(target, expected).catch((error) => {
        lastError = error;
        return null;
      });

      if (resolvedValue) {
        const selectedViaWidget = await selectPrimeFacesOption(page, target, expected, step).catch((error) => {
          lastError = error;
          return false;
        });

        if (selectedViaWidget) {
          return;
        }

        try {
          await setNativeSelectValue(target, resolvedValue);
          return;
        } catch (error) {
          lastError = error;
        }
      }
    } else {
      const selectedViaCustomControl = await selectCustomOption(page, target, expected, step).catch((error) => {
        lastError = error;
        return false;
      });

      if (selectedViaCustomControl) {
        return;
      }
    }

    await sleep(250);
  }

  if (lastError?.code === "select_option_not_available") {
    throw lastError;
  }

  throw new Error(
    `Could not select option "${expected}" for selector ${step.selector ?? "(locator)"}: ${
      lastError instanceof Error ? lastError.message : "no matching option"
    }`,
  );
}

export async function getSelectOptions(locator) {
  return locator.first().evaluate((select) => {
    if (!(select instanceof HTMLSelectElement)) {
      return [];
    }

    return [...select.options]
      .map((option) => ({
        value: option.value,
        text: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
      }))
      .filter((option) => option.text);
  });
}

async function isHtmlSelect(locator) {
  return locator.evaluate((element) => element instanceof HTMLSelectElement);
}

async function selectCustomOption(page, locator, expected, step) {
  const timeout = step.timeoutMs ?? 10000;

  await locator.waitFor({ state: "visible", timeout });
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  await openCustomSelectOptions(page, locator, timeout);

  const optionsLocator = page.locator(customOptionSelector);
  await optionsLocator.first().waitFor({ state: "visible", timeout });

  const options = await collectVisibleOptions(optionsLocator);
  const match = resolveOptionMatch(options, expected);

  if (!match) {
    await page.keyboard.press("Escape").catch(() => {});
    const error = new Error(
      `Could not find custom select option matching "${expected}". Available options: ${options
        .map((option) => option.text)
        .filter(Boolean)
        .slice(0, 20)
        .join(" | ")}`,
    );
    error.code = "select_option_not_available";
    error.expectedValue = expected;
    error.availableOptions = options.map((option) => ({
      text: option.text,
      value: option.value,
      ariaLabel: option.ariaLabel,
      title: option.title,
    }));
    throw error;
  }

  await optionsLocator.nth(match.index).click({ timeout });
  await page.waitForLoadState("networkidle", { timeout: step.afterSelectTimeoutMs ?? 5000 }).catch(() => {});
  await sleep(step.afterSelectWaitMs ?? 500);
  return true;
}

async function openCustomSelectOptions(page, locator, timeout) {
  const optionsLocator = page.locator(customOptionSelector);
  const attempts = [
    async () => locator.click({ timeout }),
    async () => locator.click({ timeout, force: true }),
    async () => {
      await locator.focus({ timeout });
      await page.keyboard.press("Space");
    },
    async () => {
      await locator.focus({ timeout });
      await page.keyboard.press("ArrowDown");
    },
    async () =>
      locator.evaluate((element) => {
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }),
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      await attempt();
      await optionsLocator.first().waitFor({ state: "visible", timeout: 1200 });
      return;
    } catch (error) {
      lastError = error;
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(150);
    }
  }

  if (lastError) {
    throw lastError;
  }
}

async function collectVisibleOptions(optionsLocator) {
  return optionsLocator.evaluateAll((elements) =>
    elements
      .map((element, index) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          element.getAttribute("aria-disabled") !== "true";

        return {
          index,
          visible,
          text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
          value:
            element.getAttribute("value") ??
            element.getAttribute("ng-reflect-value") ??
            element.getAttribute("data-value") ??
            "",
          ariaLabel: element.getAttribute("aria-label") ?? "",
          title: element.getAttribute("title") ?? "",
        };
      })
      .filter((option) => option.visible && (option.text || option.value || option.ariaLabel || option.title)),
  );
}

async function selectPrimeFacesOption(page, locator, expected, step) {
  const option = await resolvePrimeFacesOption(locator, expected);

  if (!option) {
    return false;
  }

  const widget = page.locator(`[id="${option.widgetId}"]`);
  const panel = page.locator(`[id="${option.panelId}"]`);
  await widget.click({ timeout: step.timeoutMs ?? 10000 });

  const items = panel.locator(".ui-selectonemenu-item");
  await items.first().waitFor({ state: "visible", timeout: step.timeoutMs ?? 10000 });
  await items.nth(option.index).click({ timeout: step.timeoutMs ?? 10000 });
  await page.waitForLoadState("networkidle", { timeout: step.afterSelectTimeoutMs ?? 5000 }).catch(() => {});
  await sleep(step.afterSelectWaitMs ?? 500);
  return selectedOptionMatches(locator, option);
}

async function resolvePrimeFacesOption(locator, expected) {
  return locator.evaluate((select, value) => {
    if (!(select instanceof HTMLSelectElement) || !select.id.endsWith("_input")) {
      return null;
    }

    const normalize = (text) =>
      String(text ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[.,/()]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
    const expectedText = normalize(value);
    const expectedCode = String(value ?? "").match(/^[A-Z0-9]+/)?.[0]?.toUpperCase() ?? null;
    const options = [...select.options].map((item, index) => ({
      index,
      value: item.value,
      text: item.textContent,
      normalizedValue: normalize(item.value),
      normalizedText: normalize(item.textContent),
    }));
    const match = options.find(
      (item) =>
        item.normalizedText &&
        (item.normalizedValue === expectedText ||
          item.normalizedText === expectedText ||
          (expectedCode &&
            (item.normalizedValue === expectedCode ||
              item.normalizedText === expectedCode ||
              item.normalizedText.startsWith(`${expectedCode} `) ||
              item.normalizedText.startsWith(`${expectedCode} -`))) ||
          item.normalizedText.includes(expectedText) ||
          (expectedText.length >= 6 && expectedText.includes(item.normalizedText))),
    );

    if (!match || !match.normalizedText) {
      return null;
    }

    const widgetId = select.id.replace(/_input$/, "");

    return {
      index: match.index,
      value: match.value,
      widgetId,
      panelId: `${widgetId}_panel`,
      text: match.text,
    };
  }, expected);
}

async function setNativeSelectValue(locator, value) {
  await locator.evaluate((select, nextValue) => {
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("Element is not a select.");
    }

    if (select.disabled) {
      throw new Error("Select is disabled.");
    }

    const option = [...select.options].find((item) => item.value === nextValue);

    if (!option) {
      throw new Error(`Option value not found: ${nextValue}`);
    }

    select.value = nextValue;
    option.selected = true;
    for (const item of select.options) {
      item.selected = item === option;
    }

    const widgetId = select.id.endsWith("_input") ? select.id.replace(/_input$/, "") : null;
    const label = widgetId ? document.getElementById(`${widgetId}_label`) : null;

    if (label) {
      label.textContent = option.textContent ?? "";
    }

    const panel = widgetId ? document.getElementById(`${widgetId}_panel`) : null;
    const items = panel ? [...panel.querySelectorAll(".ui-selectonemenu-item")] : [];

    items.forEach((item, index) => {
      item.classList.toggle("ui-state-highlight", index === option.index);
    });

    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value);
}

async function selectedOptionMatches(locator, expectedOption) {
  return locator.evaluate((select, option) => {
    if (!(select instanceof HTMLSelectElement)) {
      return false;
    }

    const normalize = (text) =>
      String(text ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[.,/()]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
    const selected = select.options[select.selectedIndex];
    const widgetId = select.id.endsWith("_input") ? select.id.replace(/_input$/, "") : null;
    const label = widgetId ? document.getElementById(`${widgetId}_label`)?.textContent : "";
    const expectedValue = String(option.value ?? "");
    const expectedText = normalize(option.text);

    return (
      select.value === expectedValue ||
      selected?.value === expectedValue ||
      normalize(selected?.textContent) === expectedText ||
      normalize(label) === expectedText
    );
  }, expectedOption);
}

async function resolveNativeSelectOptionValue(locator, expected) {
  const options = await locator.evaluate((select) => {
    if (!(select instanceof HTMLSelectElement)) {
      return [];
    }

    return [...select.options].map((option) => ({
      value: option.value,
      text: option.textContent,
    }));
  });

  return resolveOptionMatch(options, expected)?.value ?? null;
}

function resolveOptionMatch(options, rawExpected) {
  const expectedVariants = buildExpectedVariants(rawExpected);
  const normalizedVariants = expectedVariants.map(normalizeOptionText).filter(Boolean);
  const expectedText = normalizedVariants[0] ?? "";
  const expectedCode = String(rawExpected ?? "").match(/^[A-Z0-9]+/)?.[0]?.toUpperCase() ?? null;
  const normalizedOptions = options.map((option) => ({
    ...option,
    normalizedValue: normalizeOptionText(option.value),
    normalizedText: normalizeOptionText(option.text),
    normalizedAriaLabel: normalizeOptionText(option.ariaLabel),
    normalizedTitle: normalizeOptionText(option.title),
  }));
  const fieldsFor = (option) =>
    [option.normalizedValue, option.normalizedText, option.normalizedAriaLabel, option.normalizedTitle].filter(Boolean);

  const exact = normalizedOptions.find((option) =>
    fieldsFor(option).some((field) => normalizedVariants.includes(field) || field === expectedText),
  );

  if (exact) {
    return exact;
  }

  if (expectedCode) {
    const byCode = normalizedOptions.find((option) =>
      fieldsFor(option).some(
        (field) =>
          field === expectedCode ||
          field.startsWith(`${expectedCode} `) ||
          field.startsWith(`${expectedCode}-`) ||
          field.startsWith(`${expectedCode} -`),
      ),
    );

    if (byCode) {
      return byCode;
    }
  }

  return normalizedOptions.find((option) =>
    fieldsFor(option).some((field) =>
      normalizedVariants.some(
        (variant) =>
          (variant.length >= 3 && field.includes(variant)) ||
          (field.length >= 4 && variant.length >= 6 && variant.includes(field)),
      ),
    ),
  );
}

function buildExpectedVariants(value) {
  const text = String(value ?? "").trim();
  const variants = new Set([text]);
  const withoutCode = text.replace(/^[A-Z0-9]+\s*[-:]\s*/i, "").trim();
  const afterEstadoDe = text.replace(/^ESTADO\s+DE\s+/i, "").trim();
  const catalogLabel = getSatCatalogLabel(text);

  if (withoutCode && withoutCode !== text) {
    variants.add(withoutCode);
  }

  if (afterEstadoDe && afterEstadoDe !== text) {
    variants.add(afterEstadoDe);
  }

  if (catalogLabel) {
    variants.add(catalogLabel);
  }

  return [...variants];
}

function getSatCatalogLabel(code) {
  const normalizedCode = String(code ?? "").trim().toUpperCase();

  if (!normalizedCode) {
    return null;
  }

  return (
    SAT_CFDI_CATALOG_POLICY.regimeCatalog[normalizedCode]?.label ??
    SAT_CFDI_CATALOG_POLICY.regimeCatalog[normalizedCode]?.description ??
    SAT_CFDI_CATALOG_POLICY.cfdiUseCatalog[normalizedCode]?.label ??
    SAT_CFDI_CATALOG_POLICY.cfdiUseCatalog[normalizedCode]?.description ??
    null
  );
}

function normalizeOptionText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,/()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
