import { join } from 'node:path'

import { createEdge } from './proxy.ts'
import { loadConfig } from './routes.ts'

const root = join(import.meta.dirname, '..', '..')
const config = loadConfig(process.env.FIG_ROUTES ?? join(root, 'edge', 'routes.yaml'))
const port = Number(process.env.EDGE_PORT ?? 4000)
createEdge({ config, shadowDir: join(root, 'migration', 'shadow') }).listen(port, () => {
  console.log(`fig edge on ${port}: ${config.routes.length} routes, default ${config.default}`)
})
