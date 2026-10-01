import { LegacyIndex } from '../search.ts'

const started = Date.now()
const index = await LegacyIndex.open({ rebuild: true })
const kinds = index.chunks.reduce<Record<string, number>>((m, c) => ({ ...m, [c.kind]: (m[c.kind] ?? 0) + 1 }), {})
console.log(`indexed ${index.chunks.length} chunks (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}) in ${Date.now() - started} ms`)
