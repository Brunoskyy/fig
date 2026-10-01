import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export function close(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections()
    server.close(() => r())
  })
}
