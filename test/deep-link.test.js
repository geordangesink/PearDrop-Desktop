const test = require('node:test')
const assert = require('node:assert/strict')
const { isDeepLink, findDeepLink } = require('../electron/lib/deep-link')
const { normalizeBuffer } = require('../electron/lib/buffer')

test('isDeepLink validates protocol links', () => {
  assert.equal(isDeepLink('peardrops://invite?x=1'), true)
  assert.equal(isDeepLink('https://example.com'), false)
  assert.equal(isDeepLink(''), false)
})

test('findDeepLink returns first matching deep link', () => {
  const args = ['--foo', 'peardrops://invite?drive=abc', 'peardrops://invite?drive=def']
  assert.equal(findDeepLink(args), 'peardrops://invite?drive=abc')
})

test('normalizeBuffer accepts renderer-like payloads', () => {
  const text = 'hello'
  const b1 = normalizeBuffer(text)
  assert.equal(b1.toString('utf8'), text)

  const b2 = normalizeBuffer(Uint8Array.from([104, 105]))
  assert.equal(b2.toString('utf8'), 'hi')

  const b3 = normalizeBuffer({ type: 'Buffer', data: [111, 107] })
  assert.equal(b3.toString('utf8'), 'ok')
})
