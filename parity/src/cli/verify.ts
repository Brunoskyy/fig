import { verify } from '../verify.ts'

// One JSON line for the guard hook. Exit 0 only when the route verified.
const route = process.argv[2]
if (!route) {
  console.error('usage: npm run verify -- <route>')
  process.exit(2)
}
try {
  const verdict = await verify(route)
  console.log(JSON.stringify(verdict))
  process.exitCode = verdict.passed ? 0 : 1
} catch (e) {
  console.log(JSON.stringify({ route, passed: false, why: (e as Error).message }))
  process.exitCode = 1
}
