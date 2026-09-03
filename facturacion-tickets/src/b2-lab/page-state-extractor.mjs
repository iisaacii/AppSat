export async function extractVisiblePageState(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };
    const selectorFor = (element) => {
      const id = element.getAttribute("id");
      const name = element.getAttribute("name");
      const placeholder = element.getAttribute("placeholder");

      if (id) return `[id="${cssEscape(id)}"]`;
      if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      if (placeholder) return `${element.tagName.toLowerCase()}[placeholder="${cssEscape(placeholder)}"]`;

      return null;
    };
    const labelFor = (element) => {
      const id = element.getAttribute("id");
      const aria = element.getAttribute("aria-label");
      const placeholder = element.getAttribute("placeholder");
      const title = element.getAttribute("title");
      const explicit = id ? document.querySelector(`label[for="${cssEscape(id)}"]`) : null;
      const parentText = normalize(element.closest(".input-group-text, .form-group, .row, div")?.innerText).slice(0, 180);

      return normalize([explicit?.innerText, aria, placeholder, title, parentText].filter(Boolean).join(" | "));
    };
    const controlText = (element) =>
      uniqueText(
        [
          element.innerText,
          element.textContent,
          element.value,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("alt"),
          element.getAttribute("id"),
          element.getAttribute("name"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    const disabled = (element) =>
      element.disabled === true ||
      element.getAttribute("disabled") !== null ||
      element.getAttribute("aria-disabled") === "true";
    const readonly = (element) =>
      element.readOnly === true ||
      element.getAttribute("readonly") !== null ||
      element.getAttribute("aria-readonly") === "true";
    const editable = (element) => !disabled(element) && !readonly(element);
    const classText = (element) => normalize(element.getAttribute("class") ?? "").slice(0, 200);
    const sectionTextFor = (element) =>
      normalize(element.closest("section, fieldset, form, .step, .panel, .card, .row, div")?.innerText).slice(0, 300);
    const formTextFor = (element) => normalize(element.closest("form")?.innerText).slice(0, 500);
    const cssEscape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const inputs = [...document.querySelectorAll("input, textarea")]
      .filter(
        (element) =>
          visible(element) &&
          !disabled(element) &&
          !["hidden", "submit", "button", "image"].includes((element.type ?? "").toLowerCase()),
      )
      .map((element, index) => ({
        index,
        kind: "input",
        selector: selectorFor(element),
        id: element.getAttribute("id") ?? null,
        name: element.getAttribute("name") ?? null,
        type: element.getAttribute("type") ?? element.tagName.toLowerCase(),
        label: labelFor(element),
        placeholder: element.getAttribute("placeholder") ?? null,
        value: element.value ?? "",
        maxLength: element.getAttribute("maxlength") ?? null,
        required: element.required || element.closest(".input-group-text")?.innerText?.includes("*") || false,
        enabled: !disabled(element),
        readonly: readonly(element),
        editable: editable(element),
        role: element.getAttribute("role") ?? null,
        classes: classText(element),
        sectionText: sectionTextFor(element),
        formText: formTextFor(element),
        visibleText: normalize(element.innerText || element.textContent || element.value || ""),
      }))
      .filter((entry) => entry.selector);
    const nativeSelects = [...document.querySelectorAll("select")]
      .filter((element) => visible(element) && !disabled(element))
      .map((element, index) => ({
        index,
        kind: "select",
        selector: selectorFor(element),
        id: element.getAttribute("id") ?? null,
        name: element.getAttribute("name") ?? null,
        label: labelFor(element),
        value: element.value ?? "",
        required: element.required || false,
        enabled: !disabled(element),
        readonly: readonly(element),
        editable: !disabled(element),
        role: element.getAttribute("role") ?? null,
        classes: classText(element),
        sectionText: sectionTextFor(element),
        formText: formTextFor(element),
        visibleText: normalize(element.innerText || element.textContent || element.value || ""),
        options: [...element.options].slice(0, 80).map((option) => ({
          value: option.value,
          text: normalize(option.textContent),
        })),
      }))
      .filter((entry) => entry.selector);
    const customSelects = [...document.querySelectorAll("mat-select, [role='combobox']")]
      .filter((element) => visible(element) && !disabled(element) && selectorFor(element))
      .map((element, index) => ({
        index: nativeSelects.length + index,
        kind: "custom_select",
        selector: selectorFor(element),
        id: element.getAttribute("id") ?? null,
        name: element.getAttribute("name") ?? null,
        label: labelFor(element),
        value: normalize(element.innerText || element.textContent || element.getAttribute("aria-label") || ""),
        required: true,
        enabled: !disabled(element),
        readonly: readonly(element),
        editable: !disabled(element),
        role: element.getAttribute("role") ?? null,
        classes: classText(element),
        sectionText: sectionTextFor(element),
        formText: formTextFor(element),
        visibleText: normalize(element.innerText || element.textContent || ""),
        options: [],
      }));
    const selects = [...nativeSelects, ...customSelects];
    const buttons = [...document.querySelectorAll("button, input[type='submit'], input[type='button'], input[type='image'], a")]
      .filter((element) => visible(element))
      .map((element, index) => ({
        index,
        kind: "button",
        selector: selectorFor(element) ?? textSelector(element),
        id: element.getAttribute("id") ?? null,
        name: element.getAttribute("name") ?? null,
        tag: element.tagName.toLowerCase(),
        text: controlText(element),
        href: element.getAttribute("href") ?? null,
        enabled: !disabled(element),
        role: element.getAttribute("role") ?? null,
        classes: classText(element),
        sectionText: sectionTextFor(element),
        formText: formTextFor(element),
        looksFinal: /facturar|generar\s+factura|emitir|timbrar|finalizar/i.test(controlText(element)),
      }))
      .filter((entry) => entry.selector && entry.text);
    const bodyText = normalize(document.body?.innerText).slice(0, 3000);
    const alerts = [...document.querySelectorAll(".modal, [role='dialog'], .alert, .swal2-popup")]
      .filter((element) => visible(element))
      .map((element) => normalize(element.innerText).slice(0, 1000))
      .filter(Boolean);
    const toastMessages = [
      ...document.querySelectorAll(".toast, .ui-growl, .ui-messages, .ui-message, .mat-snack-bar-container, .p-toast"),
    ]
      .filter((element) => visible(element))
      .map((element) => normalize(element.innerText).slice(0, 1000))
      .filter(Boolean);
    const blockingOverlay = [...document.querySelectorAll(".modal, [role='dialog'], .swal2-popup, .ui-dialog")]
      .some((element) => visible(element));
    const securitySignals = collectSecuritySignals();
    const frames = [...document.querySelectorAll("iframe")]
      .filter((element) => visible(element))
      .map((element, index) => ({
        index,
        src: element.getAttribute("src") ?? null,
        title: element.getAttribute("title") ?? null,
        id: element.getAttribute("id") ?? null,
        name: element.getAttribute("name") ?? null,
        classes: classText(element),
      }))
      .slice(0, 20);
    const links = [...document.querySelectorAll("a[href]")]
      .filter((element) => visible(element))
      .map((element, index) => ({
        index,
        selector: selectorFor(element) ?? textSelector(element),
        text: controlText(element),
        href: element.getAttribute("href") ?? null,
        classes: classText(element),
        sectionText: sectionTextFor(element),
      }))
      .filter((entry) => entry.selector && entry.href)
      .slice(0, 80);
    const downloadLinks = [...document.querySelectorAll("a[href], a[download], button, input[type='button'], input[type='submit'], input[type='image']")]
      .filter((element) => visible(element))
      .map((element, index) => ({
        index,
        selector: selectorFor(element) ?? textSelector(element),
        text: controlText(element),
        href: element.getAttribute("href") ?? null,
        download: element.getAttribute("download") ?? null,
        enabled: !disabled(element),
      }))
      .filter((entry) => entry.selector && /xml|pdf|descargar|download|comprobante|cfdi/i.test(`${entry.text} ${entry.href} ${entry.download}`));

    return {
      url: location.href,
      title: document.title,
      bodyText,
      inputs,
      selects,
      buttons,
      alerts,
      toastMessages,
      blockingOverlay,
      securitySignals,
      frames,
      links,
      downloadLinks,
    };

    function textSelector(element) {
      const text = controlText(element);
      const tag = element.tagName.toLowerCase();
      if (!text) return null;
      if (tag === "a") return `a:has-text("${cssEscape(text.slice(0, 60))}")`;
      if (tag === "button") return `button:has-text("${cssEscape(text.slice(0, 60))}")`;
      return null;
    }

    function uniqueText(value) {
      const parts = normalize(value).split(" ");
      const half = parts.length / 2;

      if (Number.isInteger(half) && parts.slice(0, half).join(" ") === parts.slice(half).join(" ")) {
        return parts.slice(0, half).join(" ");
      }

      return parts.join(" ");
    }

    function collectSecuritySignals() {
      const scripts = [...document.querySelectorAll("script[src]")]
        .map((element) => element.getAttribute("src") ?? "")
        .filter(Boolean);
      const metas = [...document.querySelectorAll("meta[name], meta[http-equiv]")]
        .map((element) => ({
          name: element.getAttribute("name") ?? element.getAttribute("http-equiv") ?? "",
          content: element.getAttribute("content") ?? "",
        }))
        .filter((entry) => entry.name || entry.content);
      const source = normalize(
        [
          location.href,
          document.title,
          document.body?.innerText,
          scripts.join(" "),
          metas.map((entry) => `${entry.name} ${entry.content}`).join(" "),
        ].join(" "),
      );
      const patterns = [
        ["http_403", /403|forbidden|access is denied|access denied/i],
        ["cloudflare", /cloudflare|cf-browser-verification|cf-chl|turnstile/i],
        ["perimeterx", /perimeterx|px-captcha|_px/i],
        ["distil", /distil|distil_r_captcha/i],
        ["sucuri", /sucuri/i],
        ["datadome", /datadome/i],
        ["stormcaster_perfdrive", /stormcaster|perfdrive|validate\.perfdrive/i],
        ["recaptcha", /recaptcha|g-recaptcha|no soy un robot/i],
        ["captcha", /captcha/i],
      ];

      return patterns
        .filter(([, pattern]) => pattern.test(source))
        .map(([id]) => id);
    }
  });
}
