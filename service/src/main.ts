import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createService } from './app.ts'
import { openDatabase } from './db/database.ts'

const file = process.env.QUAYSIDE_DB ?? join(import.meta.dirname, '..', '..', 'data', 'quayside.db')
mkdirSync(dirname(file), { recursive: true })
const app = await createService({ db: openDatabase(file) })
const port = Number(process.env.SERVICE_PORT ?? 4200)
await app.listen(port)
console.log(`fig service listening on ${port}`)
