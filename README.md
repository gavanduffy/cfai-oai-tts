# cf ai aura-2-en proxy

Cloudflare Workers proxy for `@cf/deepgram/aura-2-en` that returns OpenAI-style speech responses only.

## Entry point

Use `handleOpenAISpeechProxy(request, env)` as your Worker `fetch` handler.

## Supported OpenAI speech fields

- `input`
- `voice`
- `response_format`
- `model` (ignored; always uses aura-2-en)

## Output

Binary audio only, with OpenAI-style error JSON on failures.
