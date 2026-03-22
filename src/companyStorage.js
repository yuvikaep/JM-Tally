/** Multi-company registry + per-company isolated storage keys (localStorage / CreateOS). */

export const REGISTRY_KEY = "hisaab_registry_v1"
/** Bump when storage shape changes; migration runs before legacy keys are removed. */
export const STORAGE_EPOCH = 4

const SUFFIX = {
  txns: "txns_v3",
  invoices: "invoices_v1",
  inventory: "inventory_v1",
  importHistory: "import_history_v1",
  settings: "settings_v1",
  audit: "audit_v1",
}

/** Suffix segment in `companyStorageKey(companyId, suffix)` — for migrations / copies. */
export const COMPANY_KEY_SUFFIXES = Object.values(SUFFIX)

const FLAT_KEYS = ["txns_v3", "invoices_v1", "inventory_v1", "import_history_v1", "settings_v1", "audit_v1"]

export function companyStorageKey(companyId, suffix) {
  return `hisaab_co_${companyId}_${suffix}`
}

export function newCompanyId() {
  return "co_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9)
}

export async function readRegistry(store) {
  const r = await store.get(REGISTRY_KEY)
  if (r?.companies && Array.isArray(r.companies) && r.companies.length) return r
  return null
}

export async function writeRegistry(store, reg) {
  await store.set(REGISTRY_KEY, { version: 1, ...reg })
}

export async function captureFlatLegacy(store) {
  const out = {}
  for (const k of FLAT_KEYS) out[k] = await store.get(k)
  return out
}

export async function wipeFlatLegacy(store) {
  for (const k of FLAT_KEYS) await store.remove(k)
}

function legacyHasData(leg) {
  if (!leg) return false
  const tx = leg.txns_v3
  if (Array.isArray(tx) && tx.length) return true
  if (Array.isArray(leg.invoices_v1) && leg.invoices_v1.length) return true
  if (Array.isArray(leg.inventory_v1) && leg.inventory_v1.length) return true
  if (Array.isArray(leg.import_history_v1) && leg.import_history_v1.length) return true
  if (leg.settings_v1 && typeof leg.settings_v1 === "object" && Object.keys(leg.settings_v1).length) return true
  if (Array.isArray(leg.audit_v1) && leg.audit_v1.length) return true
  return false
}

async function persistFromLegacyShape(store, companyId, legacy) {
  await store.set(companyStorageKey(companyId, SUFFIX.txns), Array.isArray(legacy.txns_v3) ? legacy.txns_v3 : [])
  await store.set(companyStorageKey(companyId, SUFFIX.invoices), Array.isArray(legacy.invoices_v1) ? legacy.invoices_v1 : [])
  await store.set(companyStorageKey(companyId, SUFFIX.inventory), Array.isArray(legacy.inventory_v1) ? legacy.inventory_v1 : [])
  await store.set(
    companyStorageKey(companyId, SUFFIX.importHistory),
    Array.isArray(legacy.import_history_v1) ? legacy.import_history_v1 : []
  )
  await store.set(
    companyStorageKey(companyId, SUFFIX.settings),
    legacy.settings_v1 && typeof legacy.settings_v1 === "object"
      ? legacy.settings_v1
      : { acctRole: "Admin", periodLockIso: "" }
  )
  await store.set(companyStorageKey(companyId, SUFFIX.audit), Array.isArray(legacy.audit_v1) ? legacy.audit_v1 : [])
}

export function normalizeLoadedPayload(raw) {
  const txRaw = raw.txns_v3
  return {
    txns: Array.isArray(txRaw) ? txRaw : [],
    invoices: Array.isArray(raw.invoices_v1) ? raw.invoices_v1 : [],
    inventory: Array.isArray(raw.inventory_v1) ? raw.inventory_v1 : [],
    importHistory: Array.isArray(raw.import_history_v1) ? raw.import_history_v1 : [],
    settings:
      raw.settings_v1 && typeof raw.settings_v1 === "object"
        ? raw.settings_v1
        : { acctRole: "Admin", periodLockIso: "" },
    audit: Array.isArray(raw.audit_v1) ? raw.audit_v1 : [],
  }
}

export async function loadCompanyPayload(store, companyId) {
  const raw = {
    txns_v3: await store.get(companyStorageKey(companyId, SUFFIX.txns)),
    invoices_v1: await store.get(companyStorageKey(companyId, SUFFIX.invoices)),
    inventory_v1: await store.get(companyStorageKey(companyId, SUFFIX.inventory)),
    import_history_v1: await store.get(companyStorageKey(companyId, SUFFIX.importHistory)),
    settings_v1: await store.get(companyStorageKey(companyId, SUFFIX.settings)),
    audit_v1: await store.get(companyStorageKey(companyId, SUFFIX.audit)),
  }
  return normalizeLoadedPayload(raw)
}

export async function persistCompanyPayload(store, companyId, state) {
  const { txns, invoices, inventory, importHistory, settings } = state
  await store.set(companyStorageKey(companyId, SUFFIX.txns), Array.isArray(txns) ? txns : [])
  await store.set(companyStorageKey(companyId, SUFFIX.invoices), Array.isArray(invoices) ? invoices : [])
  await store.set(companyStorageKey(companyId, SUFFIX.inventory), Array.isArray(inventory) ? inventory : [])
  await store.set(companyStorageKey(companyId, SUFFIX.importHistory), Array.isArray(importHistory) ? importHistory : [])
  await store.set(companyStorageKey(companyId, SUFFIX.settings), settings || { acctRole: "Admin", periodLockIso: "" })
}

export async function appendCompanyAudit(store, companyId, entry) {
  if (!companyId) return
  const key = companyStorageKey(companyId, SUFFIX.audit)
  const prev = (await store.get(key)) || []
  await store.set(key, [...prev.slice(-480), { ...entry, ts: entry.ts || new Date().toISOString() }])
}

export async function removeCompanyData(store, companyId) {
  for (const suf of Object.values(SUFFIX)) {
    await store.remove(companyStorageKey(companyId, suf))
  }
}

/**
 * Run on app load: epoch migration (capture flat keys before wipe), ensure registry + active company.
 */
export async function bootstrapCompanies(store, epochTarget) {
  const epoch = await store.get("hisaab_epoch")
  let registry = await readRegistry(store)

  if (epoch !== epochTarget) {
    const legacy = await captureFlatLegacy(store)
    await wipeFlatLegacy(store)
    await store.set("hisaab_epoch", epochTarget)
    if (!registry?.companies?.length) {
      const DEFAULT_ID = "co_default"
      registry = {
        version: 1,
        companies: [
          {
            id: DEFAULT_ID,
            name: legacyHasData(legacy) ? "My company" : "My company",
            legalName: "",
            bankAccountLabel: "",
          },
        ],
        activeCompanyId: DEFAULT_ID,
      }
      await writeRegistry(store, registry)
      await persistFromLegacyShape(store, DEFAULT_ID, legacy)
    }
  }

  registry = await readRegistry(store)
  if (!registry?.companies?.length) {
    const id = newCompanyId()
    registry = {
      version: 1,
      companies: [{ id, name: "My company", legalName: "", bankAccountLabel: "" }],
      activeCompanyId: id,
    }
    await writeRegistry(store, registry)
    await persistCompanyPayload(store, id, {
      txns: [],
      invoices: [],
      inventory: [],
      importHistory: [],
      settings: { acctRole: "Admin", periodLockIso: "" },
    })
  }

  let activeId = registry.activeCompanyId
  if (!registry.companies.some(c => c.id === activeId)) activeId = registry.companies[0].id
  if (activeId !== registry.activeCompanyId) {
    registry = { ...registry, activeCompanyId: activeId }
    await writeRegistry(store, registry)
  }

  const payload = await loadCompanyPayload(store, activeId)
  return { registry, activeCompanyId: activeId, payload }
}

/**
 * One-time move from legacy unprefixed keys (pre–per-user storage) into `scopedStore`.
 * Clears legacy registry + company keys from `rawStore` so data is not duplicated.
 */
export async function migrateLegacyBooksToUserScope(rawStore, scopedStore) {
  const scopedReg = await readRegistry(scopedStore)
  if (scopedReg?.companies?.length) return

  const legacyReg = await readRegistry(rawStore)
  if (!legacyReg?.companies?.length) return

  await scopedStore.set("hisaab_epoch", STORAGE_EPOCH)
  await writeRegistry(scopedStore, legacyReg)
  for (const c of legacyReg.companies) {
    for (const suf of COMPANY_KEY_SUFFIXES) {
      const k = companyStorageKey(c.id, suf)
      const v = await rawStore.get(k)
      if (v !== null && v !== undefined) await scopedStore.set(k, v)
    }
  }

  await rawStore.remove(REGISTRY_KEY)
  for (const c of legacyReg.companies) {
    for (const suf of COMPANY_KEY_SUFFIXES) {
      await rawStore.remove(companyStorageKey(c.id, suf))
    }
  }
  await rawStore.remove("hisaab_epoch")
}
