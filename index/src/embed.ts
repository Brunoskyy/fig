import { homedir } from 'node:os'
import { join } from 'node:path'

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

export const MODEL = 'Xenova/bge-small-en-v1.5'
/** Models live outside the repo. CI and fresh machines download them once into the same place. */
export const MODEL_DIR = process.env.FIG_MODELS ?? join(homedir(), '.cache', 'fig-models')

/** bge wants this prefix on queries, not on passages. */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

let extractor: Promise<FeatureExtractionPipeline> | null = null

function load(): Promise<FeatureExtractionPipeline> {
  env.localModelPath = MODEL_DIR
  env.cacheDir = MODEL_DIR
  env.allowRemoteModels = process.env.FIG_ALLOW_DOWNLOAD === '1'
  extractor ??= pipeline('feature-extraction', MODEL, { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>
  return extractor
}

async function embed(texts: string[]): Promise<number[][]> {
  const run = await load()
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += 16) {
    const tensor = await run(texts.slice(i, i + 16), { pooling: 'cls', normalize: true })
    out.push(...(tensor.tolist() as number[][]))
  }
  return out
}

export const embedPassages = (texts: string[]) => embed(texts)
export const embedQuery = async (text: string) => (await embed([QUERY_PREFIX + text]))[0]!

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!
  return dot
}
