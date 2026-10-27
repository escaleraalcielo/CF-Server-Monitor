import assert from 'node:assert/strict'
import test from 'node:test'

// Frontend modules read browser storage at import time; stub it before importing them.
const storage = new Map()
const localStorageStub = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
  clear: () => { storage.clear() }
}
globalThis.localStorage = localStorageStub
globalThis.window = { localStorage: localStorageStub }

const { LANGUAGE_CODES } = await import('../src/shared/languages.js')
const {
  DISPLAY_FINANCE_CURRENCIES,
  getDefaultFinanceCurrency,
  getStoredFinanceCurrency,
  setStoredFinanceCurrency
} = await import('../src/frontend/utils/finance.js')
const { clearSiteSettingsCache, loadSiteSettings } = await import('../src/utils/settings.js')

test('display currency default follows the interface language', () => {
  assert.equal(getDefaultFinanceCurrency('zh'), 'CNY')
  assert.equal(getDefaultFinanceCurrency('zh-TW'), 'HKD')
  assert.equal(getDefaultFinanceCurrency('en'), 'USD')
  assert.equal(getDefaultFinanceCurrency('ja'), 'JPY')
  assert.equal(getDefaultFinanceCurrency('fr'), 'EUR')
  assert.equal(getDefaultFinanceCurrency('es'), 'EUR')
  assert.equal(getDefaultFinanceCurrency('id'), 'CNY')

  for (const language of ['ko', 'auto', '', null, undefined]) {
    assert.equal(getDefaultFinanceCurrency(language), 'CNY')
  }

  for (const code of LANGUAGE_CODES) {
    assert.ok(
      DISPLAY_FINANCE_CURRENCIES.includes(getDefaultFinanceCurrency(code)),
      `currency default for "${code}" must be offered by the picker`
    )
  }
})

test('an explicitly stored display currency wins over the language default', () => {
  storage.clear()
  assert.equal(getStoredFinanceCurrency('en'), 'USD')
  setStoredFinanceCurrency('JPY')
  assert.equal(getStoredFinanceCurrency('en'), 'JPY')
  storage.clear()
  assert.equal(getStoredFinanceCurrency('zh-TW'), 'HKD')
})

test('site settings defaults leave carrier display names empty for locale fallback', async () => {
  clearSiteSettingsCache()
  const db = {
    prepare: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => {}
    })
  }
  const settings = await loadSiteSettings(db, { forceRefresh: true })
  for (const field of ['custom_ct_name', 'custom_cu_name', 'custom_cm_name', 'custom_bd_name']) {
    assert.equal(settings[field], '', `${field} must stay empty so the frontend can use the locale label`)
  }
  assert.equal(settings.node_1_name, 'Node 1')
  assert.equal(settings.node_2_name, 'Node 2')
  assert.equal(settings.node_3_name, 'Node 3')
  assert.equal(settings.node_4_name, 'Node 4')
})

test('ping labels prefer the custom name, then the active locale, then a neutral fallback', async () => {
  const { resolvePingLabel } = await import('../src/frontend/utils/server.js')
  const { LANGUAGE_CODES } = await import('../src/shared/languages.js')

  for (const code of LANGUAGE_CODES) {
    const locale = (await import(`../src/frontend/locales/${code}.js`)).default
    assert.ok(locale.pingCt && locale.pingCu && locale.pingCm && locale.pingBd, `locale "${code}" is missing ping label keys`)
  }
  const zhLocale = (await import('../src/frontend/locales/zh.js')).default
  const enLocale = (await import('../src/frontend/locales/en.js')).default

  // Operator has not customised the label: the active locale decides (zh keeps Chinese, en gets CT).
  assert.equal(resolvePingLabel('', zhLocale.pingCt, 'CT'), '电信')
  assert.equal(resolvePingLabel('', enLocale.pingCt, 'CT'), 'CT')
  assert.equal(resolvePingLabel('', enLocale.pingBd, 'BGP'), 'BGP')

  // A customised label always wins over the locale.
  assert.equal(resolvePingLabel('MyISP', zhLocale.pingCt, 'CT'), 'MyISP')

  // Node names have no locale key: the language-neutral default must survive.
  assert.equal(resolvePingLabel('Node 1', undefined, 'Node 1'), 'Node 1')
})
