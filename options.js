const STORAGE_KEY = "redirect_rules";
const METRICS_KEY = "redirect_metrics";
const SETTINGS_KEY = "redirect_settings";
const MINUTES_SAVED_PER_REDIRECT = 17.5;

const addRuleForm = document.getElementById("addRuleForm");
const newSourceHostnameInput = document.getElementById("newSourceHostname");
const newTargetUrlInput = document.getElementById("newTargetUrl");
const rulesBody = document.getElementById("rulesBody");
const ruleRowTemplate = document.getElementById("ruleRowTemplate");
const formMessage = document.getElementById("formMessage");
const metricsSummary = document.getElementById("metricsSummary");
const timeSavedSummary = document.getElementById("timeSavedSummary");
const moneySavedSummary = document.getElementById("moneySavedSummary");
const hourlyRateInput = document.getElementById("hourlyRateInput");
const hourlyRateError = document.getElementById("hourlyRateError");

let rules = [];
let metrics = { total_redirects: 0, per_rule: {} };
let settings = { hourly_rate: null };

function getStorageArea() {
  return chrome.storage.sync || chrome.storage.local;
}

function storageGet(key) {
  return new Promise((resolve) => {
    getStorageArea().get([key], (result) => {
      if (chrome.runtime.lastError) {
        console.error("storage get failed:", chrome.runtime.lastError.message);
        resolve({});
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(payload) {
  return new Promise((resolve, reject) => {
    getStorageArea().set(payload, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function localStorageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        console.error("local storage get failed:", chrome.runtime.lastError.message);
        resolve({});
        return;
      }
      resolve(result || {});
    });
  });
}

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function showFormMessage(message, type) {
  formMessage.textContent = message;
  formMessage.classList.remove("error", "success");
  if (type) {
    formMessage.classList.add(type);
  }
}

function validateHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();

  if (!normalized) {
    return { valid: false, error: "Hostname is required." };
  }

  if (normalized.includes("/") || normalized.includes(" ") || normalized.includes(":") || normalized.includes("?")) {
    return { valid: false, error: "Hostname must not include scheme, path, spaces, or query." };
  }

  const parts = normalized.split(".");
  if (parts.length < 2) {
    return { valid: false, error: "Hostname must include at least one dot." };
  }

  for (const label of parts) {
    if (!label) {
      return { valid: false, error: "Hostname labels cannot be empty." };
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      return { valid: false, error: "Hostname can only use letters, numbers, dots, and hyphens." };
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return { valid: false, error: "Hostname labels cannot start or end with hyphen." };
    }
  }

  return { valid: true, value: normalized };
}

function validateTargetUrl(targetUrl) {
  const trimmed = String(targetUrl || "").trim();

  if (!trimmed) {
    return { valid: false, error: "Target URL is required." };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: "Target URL must be a valid absolute URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: "Target URL must start with http:// or https://." };
  }

  return { valid: true, value: parsed.toString(), hostname: parsed.hostname.toLowerCase() };
}

function validateRule(rule) {
  const hostResult = validateHostname(rule.source_hostname);
  if (!hostResult.valid) {
    return { valid: false, sourceError: hostResult.error };
  }

  const targetResult = validateTargetUrl(rule.target_url);
  if (!targetResult.valid) {
    return { valid: false, targetError: targetResult.error };
  }

  if (targetResult.hostname === hostResult.value) {
    return { valid: false, targetError: "Target URL hostname cannot match source hostname (self-loop)." };
  }

  return {
    valid: true,
    normalized: {
      id: String(rule.id || makeId()),
      enabled: Boolean(rule.enabled),
      source_hostname: hostResult.value,
      target_url: targetResult.value
    }
  };
}

async function persistRules() {
  await storageSet({ [STORAGE_KEY]: rules });
}

function normalizeMetrics(rawMetrics) {
  if (!rawMetrics || typeof rawMetrics !== "object") {
    return { total_redirects: 0, per_rule: {} };
  }

  const totalRedirects = Number.isFinite(rawMetrics.total_redirects) ? rawMetrics.total_redirects : 0;
  const perRule = rawMetrics.per_rule && typeof rawMetrics.per_rule === "object" ? rawMetrics.per_rule : {};
  return { total_redirects: totalRedirects, per_rule: perRule };
}

function normalizeSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object") {
    return { hourly_rate: null };
  }
  const rate = Number(rawSettings.hourly_rate);
  if (!Number.isFinite(rate) || rate < 0) {
    return { hourly_rate: null };
  }
  return { hourly_rate: rate };
}

function validateHourlyRate(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) {
    return { valid: true, value: null };
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return { valid: false, error: "Hourly rate must be a valid number." };
  }
  if (parsed < 0) {
    return { valid: false, error: "Hourly rate cannot be negative." };
  }
  return { valid: true, value: Number(parsed.toFixed(2)) };
}

function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatDurationFromMinutes(totalMinutes) {
  if (totalMinutes < 60) {
    return `${totalMinutes.toFixed(1)}m`;
  }

  if (totalMinutes < 1440) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = Math.round(totalMinutes % 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.round((totalMinutes % 1440) / 60);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function formatMoneyCompact(value) {
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}k`;
  }
  return formatCurrency(value);
}

function renderMetricsSummary() {
  metricsSummary.textContent = String(metrics.total_redirects);
  const minutesSaved = metrics.total_redirects * MINUTES_SAVED_PER_REDIRECT;
  timeSavedSummary.textContent = formatDurationFromMinutes(minutesSaved);

  if (Number.isFinite(settings.hourly_rate)) {
    const perMinuteRate = settings.hourly_rate / 60;
    const moneySaved = minutesSaved * perMinuteRate;
    moneySavedSummary.textContent = formatMoneyCompact(moneySaved);
  } else {
    moneySavedSummary.textContent = "$0.00";
  }
}

function createEmptyStateRow() {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 5;
  cell.className = "empty";
  cell.textContent = "No rules yet. Add one above.";
  row.appendChild(cell);
  return row;
}

function setRowErrors(row, sourceError = "", targetError = "") {
  const sourceErrorEl = row.querySelector(".rule-source-error");
  const targetErrorEl = row.querySelector(".rule-target-error");
  sourceErrorEl.textContent = sourceError;
  targetErrorEl.textContent = targetError;
}

function renderRules() {
  rulesBody.innerHTML = "";

  if (!rules.length) {
    rulesBody.appendChild(createEmptyStateRow());
    return;
  }

  for (const rule of rules) {
    const fragment = ruleRowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");
    const enabledInput = row.querySelector(".rule-enabled");
    const sourceInput = row.querySelector(".rule-source");
    const targetInput = row.querySelector(".rule-target");
    const redirectCount = row.querySelector(".rule-redirect-count");
    const deleteButton = row.querySelector(".rule-delete");

    enabledInput.checked = Boolean(rule.enabled);
    sourceInput.value = rule.source_hostname;
    targetInput.value = rule.target_url;
    redirectCount.textContent = String(metrics.per_rule[rule.id] || 0);

    const updateRuleFromInputs = async ({ allowPersistOnInvalid = false } = {}) => {
      const draft = {
        ...rule,
        enabled: enabledInput.checked,
        source_hostname: sourceInput.value,
        target_url: targetInput.value
      };

      const validation = validateRule(draft);
      if (!validation.valid) {
        setRowErrors(row, validation.sourceError || "", validation.targetError || "");
        if (!allowPersistOnInvalid) {
          return;
        }
      } else {
        setRowErrors(row, "", "");
      }

      const index = rules.findIndex((item) => item.id === rule.id);
      if (index === -1) {
        return;
      }

      if (!validation.valid) {
        rules[index] = {
          ...draft,
          source_hostname: String(draft.source_hostname || "").trim().toLowerCase(),
          target_url: String(draft.target_url || "").trim()
        };
      } else {
        rules[index] = validation.normalized;
      }

      try {
        await persistRules();
        showFormMessage("", null);
      } catch (error) {
        showFormMessage(`Failed to save rules: ${error.message}`, "error");
      }
    };

    enabledInput.addEventListener("change", () => {
      updateRuleFromInputs({ allowPersistOnInvalid: true });
    });

    sourceInput.addEventListener("input", () => {
      updateRuleFromInputs();
    });

    targetInput.addEventListener("input", () => {
      updateRuleFromInputs();
    });

    deleteButton.addEventListener("click", async () => {
      rules = rules.filter((item) => item.id !== rule.id);
      try {
        await persistRules();
        renderRules();
        showFormMessage("", null);
      } catch (error) {
        showFormMessage(`Failed to delete rule: ${error.message}`, "error");
      }
    });

    rulesBody.appendChild(fragment);

    const initialValidation = validateRule(rule);
    if (!initialValidation.valid) {
      setRowErrors(row, initialValidation.sourceError || "", initialValidation.targetError || "");
    }
  }
}

async function loadRules() {
  const result = await storageGet(STORAGE_KEY);
  const stored = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  rules = stored.map((item) => ({
    id: String(item.id || makeId()),
    enabled: Boolean(item.enabled),
    source_hostname: String(item.source_hostname || ""),
    target_url: String(item.target_url || "")
  }));
  renderRules();
}

async function loadMetrics() {
  const result = await localStorageGet([METRICS_KEY]);
  metrics = normalizeMetrics(result[METRICS_KEY]);
  renderMetricsSummary();
  renderRules();
}

async function persistSettings() {
  await storageSet({ [SETTINGS_KEY]: settings });
}

function renderSettings() {
  hourlyRateInput.value = Number.isFinite(settings.hourly_rate) ? settings.hourly_rate.toFixed(2) : "";
}

async function loadSettings() {
  const result = await storageGet(SETTINGS_KEY);
  settings = normalizeSettings(result[SETTINGS_KEY]);
  renderSettings();
  renderMetricsSummary();
}

addRuleForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const draft = {
    id: makeId(),
    enabled: true,
    source_hostname: newSourceHostnameInput.value,
    target_url: newTargetUrlInput.value
  };

  const validation = validateRule(draft);
  if (!validation.valid) {
    showFormMessage(validation.sourceError || validation.targetError || "Invalid rule.", "error");
    return;
  }

  rules.push(validation.normalized);

  try {
    await persistRules();
    renderRules();
    newSourceHostnameInput.value = "";
    newTargetUrlInput.value = "";
    showFormMessage("Rule added.", "success");
  } catch (error) {
    showFormMessage(`Failed to save rule: ${error.message}`, "error");
  }
});

loadRules().catch((error) => {
  showFormMessage(`Failed to load rules: ${error.message}`, "error");
});

loadMetrics().catch((error) => {
  showFormMessage(`Failed to load metrics: ${error.message}`, "error");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const usingSync = Boolean(chrome.storage.sync);

  if (areaName === "local" && changes[METRICS_KEY]) {
    metrics = normalizeMetrics(changes[METRICS_KEY].newValue);
    renderMetricsSummary();
    renderRules();
  }

  if ((usingSync && areaName === "sync") || (!usingSync && areaName === "local")) {
    if (changes[SETTINGS_KEY]) {
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
      renderSettings();
      renderMetricsSummary();
    }
  }
});

hourlyRateInput.addEventListener("input", async () => {
  const validation = validateHourlyRate(hourlyRateInput.value);
  if (!validation.valid) {
    hourlyRateError.textContent = validation.error;
    return;
  }

  hourlyRateError.textContent = "";
  settings = { hourly_rate: validation.value };
  renderMetricsSummary();

  try {
    await persistSettings();
  } catch (error) {
    showFormMessage(`Failed to save hourly rate: ${error.message}`, "error");
  }
});

loadSettings().catch((error) => {
  showFormMessage(`Failed to load settings: ${error.message}`, "error");
});
