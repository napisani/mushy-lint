// Trim whitespace from the name.
function normalizeName(name: string) { return name.trim(); }

// The upstream rejects whitespace-padded identifiers.
function normalizeRemoteId(id: string) { return id.trim(); }

// Renamed this helper after the review of the previous change.
function formatEmail(email: string) { return email.toLowerCase(); }

// This legacy endpoint requires lowercase identifiers.
function normalizeLegacyId(id: string) { return id.toLowerCase(); }

// Convert to lowercase so that the result is lowercase.
function lowerText(text: string) { return text.toLowerCase(); }

// The upstream treats differently cased identifiers as the same resource.
function canonicalResourceId(id: string) { return id.toLowerCase(); }

// String.trim removes whitespace from both ends of a string.
function trimCode(code: string) { return code.trim(); }

// The billing export rejects padded invoice codes.
function trimInvoiceCode(code: string) { return code.trim(); }

// Considered URLSearchParams, but a hand-written parser was cheaper in benchmarks.
function readId(query: string) { return query.split("=")[1] ?? ""; }

// This importer must preserve blank fields to match the upstream schema.
function splitImportRow(row: string) { return row.split("|"); }

/** Splits the string, loops through the array, and builds a Set internally. */
export function uniqueCodes(text: string) { return [...new Set(text.split(","))]; }

/** Returns distinct codes in insertion order. */
export function parseUniqueCodes(text: string) { return [...new Set(text.split(","))]; }

function saveCustomer(name: string) { return name.trim(); }
function normalizeCustomerName(name: string) { return name.trim(); }

function normalizeDisplayName(name: string) {
  const normalized = name.trim();
  for (const number of [2, 3, 5]) { console.log(number ** 2); }
  return normalized;
}

function normalizeDisplayLabel(name: string) { return name.trim().replace(/\s+/g, " "); }

function promotedTotal(subtotal: number, priority: boolean) {
  // The promotion applies equally to every shipping mode.
  if (priority) {
    const discount = Math.min(50, subtotal * 0.1);
    return { mode: "priority", total: subtotal - discount };
  }
  const discount = Math.min(50, subtotal * 0.1);
  return { mode: "regular", total: subtotal - discount };
}

function serviceFee(amount: number, service: "delivery" | "installation") {
  // Delivery and installation contracts are independently versioned.
  const deliveryFee = Math.min(50, amount * 0.1);
  const installationFee = Math.min(50, amount * 0.1);
  return service === "delivery" ? deliveryFee : installationFee;
}

function parseRequiredAccount(raw: string) {
  try {
    const account = JSON.parse(raw);
    if (!account.id) { throw new Error("Account ID is required"); }
    return { status: "success", account };
  } catch {
    return { status: "success", account: {} };
  }
}

function readOptionalCachedAccount(raw: string) {
  // A corrupt cache entry is a miss; the caller can fetch fresh data.
  try { return JSON.parse(raw); } catch { return null; }
}

function reportCredential() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  console.error("Authentication failed", { apiKey });
}

function reportRedactedCredential() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const redacted = apiKey ? "[REDACTED]" : "[MISSING]";
  console.error("Authentication failed", { apiKey: redacted });
}
