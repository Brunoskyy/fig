import { LegacyIndex, MODES, type Mode } from '../search.ts'

const args = process.argv.slice(2)
const flag = args.find((a) => a.startsWith('--mode='))
const mode = (flag?.slice(7) ?? 'hybrid') as Mode
if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`)
const query = args.filter((a) => a !== flag).join(' ')
if (!query) {
  console.error('usage: npm run index:query -- [--mode=keyword|vector|hybrid] <question>')
  process.exit(2)
}
const index = await LegacyIndex.open()
for (const hit of await index.search(query, mode, 5)) {
  console.log(`${hit.rank}. ${hit.chunk.file}:${hit.chunk.start}-${hit.chunk.end}  ${hit.chunk.kind} ${hit.chunk.name}`)
}
