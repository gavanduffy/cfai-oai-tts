export type SpeechResponseFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'

export interface Env {
  AI?: { run(model: string, body: Record<string, unknown>): Promise<unknown> }
  WORKERS_AI_ACCOUNT_ID?: string
  WORKERS_AI_API_TOKEN?: string
}

export interface OpenAISpeechRequest {
  model?: string
  input?: string
  voice?: string | { id?: string }
  response_format?: SpeechResponseFormat
  speed?: number
  stream_format?: 'audio' | 'sse'
  instructions?: string
}

const DEFAULT_MODEL = '@cf/deepgram/aura-2-en'
const AURA_SPEAKERS = new Set([
  'amalthea', 'andromeda', 'apollo', 'arcas', 'aries', 'asteria', 'athena', 'atlas', 'aurora',
  'callista', 'cora', 'cordelia', 'delia', 'draco', 'electra', 'harmonia', 'helena', 'hera',
  'hermes', 'hyperion', 'iris', 'janus', 'juno', 'jupiter', 'luna', 'mars', 'minerva',
  'neptune', 'odysseus', 'ophelia', 'orion', 'orpheus', 'pandora', 'phoebe', 'pluto',
  'saturn', 'thalia', 'theia', 'vesta', 'zeus',
])

const OPENAI_TO_AURA: Record<string, string> = {
  alloy: 'luna',
  echo: 'asteria',
  fable: 'athena',
  onyx: 'zeus',
  nova: 'callista',
  shimmer: 'aurora',
  ash: 'aries',
  ballad: 'harmonia',
  coral: 'cora',
  sage: 'minerva',
  verse: 'orpheus',
  marin: 'odysseus',
}

function openAIError(message: string, status = 400, type: 'invalid_request_error' | 'server_error' = status >= 500 ? 'server_error' : 'invalid_request_error', param?: string, code?: string) {
  return Response.json(
    {
      error: {
        message,
        type,
        param: param ?? null,
        code: code ?? null,
      },
    },
    { status }
  )
}

function resolveSpeaker(voice: OpenAISpeechRequest['voice']): string {
  const raw = typeof voice === 'string' ? voice : voice?.id
  if (!raw) return 'luna'
  const normalized = raw.toLowerCase()
  if (AURA_SPEAKERS.has(normalized)) return normalized
  return OPENAI_TO_AURA[normalized] ?? 'luna'
}

function resolveAudioConfig(format: SpeechResponseFormat) {
  switch (format) {
    case 'wav':
      return { encoding: 'linear16', container: 'wav', contentType: 'audio/wav' }
    case 'opus':
      return { encoding: 'opus', container: 'ogg', contentType: 'audio/ogg' }
    case 'aac':
      return { encoding: 'aac', container: 'none', contentType: 'audio/aac' }
    case 'flac':
      return { encoding: 'flac', container: 'none', contentType: 'audio/flac' }
    case 'pcm':
      return { encoding: 'linear16', container: 'none', contentType: 'audio/pcm' }
    case 'mp3':
    default:
      return { encoding: 'mp3', container: 'none', contentType: 'audio/mpeg' }
  }
}

async function outputToBytes(output: unknown): Promise<ArrayBuffer> {
  if (output instanceof ArrayBuffer) return output
  if (output instanceof Uint8Array) return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
  if (output instanceof Response) return output.arrayBuffer()
  if (output instanceof Blob) return output.arrayBuffer()
  if (output instanceof ReadableStream) return new Response(output).arrayBuffer()

  if (typeof output === 'string') {
    return Uint8Array.from(atob(output), (c) => c.charCodeAt(0)).buffer
  }

  if (output && typeof output === 'object') {
    const maybeAudio = (output as { audio?: unknown }).audio
    if (typeof maybeAudio === 'string') {
      return Uint8Array.from(atob(maybeAudio), (c) => c.charCodeAt(0)).buffer
    }
  }

  throw new Error('Unsupported Workers AI audio response shape')
}

async function synthesizeWithWorkersAI(env: Env, model: string, body: Record<string, unknown>) {
  if (env.AI) return env.AI.run(model, body)

  if (!env.WORKERS_AI_ACCOUNT_ID || !env.WORKERS_AI_API_TOKEN) {
    throw new Error('Missing Workers AI binding or API credentials')
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.WORKERS_AI_ACCOUNT_ID}/ai/run/${encodeURIComponent(model)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WORKERS_AI_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || response.statusText)
  }

  return response.body ?? response.arrayBuffer()
}

export async function handleOpenAISpeechProxy(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return openAIError('Only POST is supported', 405, 'invalid_request_error', null, 'method_not_allowed')
  }

  let payload: OpenAISpeechRequest
  try {
    payload = (await request.json()) as OpenAISpeechRequest
  } catch {
    return openAIError('Invalid JSON body', 400, 'invalid_request_error', null, 'invalid_json')
  }

  const input = typeof payload.input === 'string' ? payload.input.trim() : ''
  if (!input) {
    return openAIError('`input` is required', 400, 'invalid_request_error', 'input', 'missing_required_parameter')
  }

  if (input.length > 4096) {
    return openAIError('`input` exceeds OpenAI speech length limits', 400, 'invalid_request_error', 'input', 'input_too_long')
  }

  const responseFormat = payload.response_format ?? 'mp3'
  const audioConfig = resolveAudioConfig(responseFormat)
  const speaker = resolveSpeaker(payload.voice)

  const providerBody: Record<string, unknown> = {
    text: input,
    speaker,
    encoding: audioConfig.encoding,
    container: audioConfig.container,
  }

  try {
    const selectedModel = DEFAULT_MODEL
    const output = await synthesizeWithWorkersAI(env, selectedModel, providerBody)
    const bytes = await outputToBytes(output)

    if (!bytes.byteLength) {
      return openAIError('Workers AI returned empty audio', 502, 'server_error', null, 'empty_audio')
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': audioConfig.contentType,
        'Content-Length': String(bytes.byteLength),
      },
    })
  } catch (error) {
    return openAIError(error instanceof Error ? error.message : 'Workers AI request failed', 502, 'server_error', null, 'upstream_error')
  }
}

export default {
  fetch: handleOpenAISpeechProxy,
}
