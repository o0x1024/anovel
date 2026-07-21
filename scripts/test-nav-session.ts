import assert from 'node:assert/strict'
import {
  getNavRestorePath,
  navKeyForPath,
  saveNavPath
} from '../src/renderer/src/services/navSession'

class MemorySessionStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemorySessionStorage(),
  configurable: true
})

assert.equal(navKeyForPath('/novel/12'), '/')
assert.equal(navKeyForPath('/causal-novel/27'), '/causal-novels')
assert.equal(navKeyForPath('/story/34'), '/stories')
assert.equal(navKeyForPath('/causal-novels'), '/causal-novels')

saveNavPath('/causal-novel/27', '/causal-novel/27?panel=causal_chapters')
assert.equal(
  getNavRestorePath('/causal-novels', '/causal-novels'),
  '/causal-novel/27?panel=causal_chapters'
)
assert.equal(getNavRestorePath('/', '/'), '/')

console.log('navigation session cache tests passed')
