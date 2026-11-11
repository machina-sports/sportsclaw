# Speech

`synthesizeSpeech` turns text into a WAV file on a route you choose in config. The `writer` model role writes narration; this speaks it. Changing where speech runs — a server you run, or a hosted service — is a config edit, the same way it is for a model role.

```ts
import { speechText, synthesizeSpeech } from "sportsclaw-engine-core";

const result = await synthesizeSpeech({
  text: speechText("**Curry** ties it with seven seconds left."),
  config: {
    roles: {},
    speech: { route: "nim", format: "riva", voice: "Magpie-Multilingual.EN-US.Jason", baseUrl: "http://127.0.0.1:9000/v1" },
  },
});
// result.audio (a complete WAV file), result.durationMs, result.trace
```

## Config

Speech sits beside the model roles as `inference.speech`:

```json
{
  "inference": {
    "roles": { "writer": { "route": "nim", "model": "..." } },
    "speech": { "route": "api", "format": "openai", "model": "gpt-4o-mini-tts", "voice": "alloy",
                "baseUrl": "https://api.openai.com/v1", "credentialEnv": "OPENAI_API_KEY" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `route` | `nim`: a speech server you run, keyless. `api`: a hosted service that needs a key. `mock`: a short silent WAV with no network, for tests. |
| `format` | The service's request shape: `riva` or `openai` (below). Not needed for `mock`. |
| `voice` | The default voice, as the service names it. |
| `model` | Required by `openai`. A `riva` server serves one model and is not sent it. |
| `language` | Language code for `riva`. Default `en-US`. |
| `baseUrl` | The endpoint, including its version prefix (`.../v1`). |
| `credentialEnv` | `api` only, required: the **name** of the environment variable holding the key. The key is read at call time and is never in config. |
| `timeoutMs` | Optional deadline. Default 60,000 ms. |

The `api` route requires HTTPS unless the endpoint is on loopback, and any field not in this table is refused, so a key cannot be pasted into config. It is not a fifth model role: the four roles return text through a chat route, and this returns audio.

## Formats

| `format` | Request | Works with |
| --- | --- | --- |
| `riva` | Form POST to `<baseUrl>/audio/synthesize` with `text`, `voice`, `language` | NVIDIA Riva / Magpie TTS NIM |
| `openai` | JSON POST to `<baseUrl>/audio/speech` with `model`, `input`, `voice`, `response_format: "wav"` | OpenAI, and hosted services and local servers that copy its speech endpoint |

Either format works on either route: `riva` on `api` for a Magpie endpoint behind a key, `openai` on `nim` for a compatible server you run.

The result is always WAV. It is what a Riva server returns and what an OpenAI-style service is asked for, so callers handle one format; a response that is not WAV is a failure.

## A call

- `voice` and `language` can be set per call, for a second speaker or an emotion (`Magpie-Multilingual.EN-US.Jason.Happy`).
- Text is limited to 4,096 characters (`SPEECH_LIMITS.maxTextChars`). Longer text is refused, never cut: send it line by line.
- Failures throw `SpeechRouteError` with a `trace` whose `status` is `failed`, `timed_out` or `cancelled`. The message names the HTTP status, never the service's own text.
- `onReceipt` receives one sanitized receipt per call (`kind: "speech"`): route, model, status and latency — no text, voice or endpoint.

`speechText()` prepares model-written text for a voice: markdown characters are removed, links keep their words, an italic source tag such as `*Live match feed*` is dropped, and dashes become pauses. `synthesizeSpeech` does not apply it for you.

## Verification

```bash
npm run build
node --test test/speech.test.mjs
```

The tests use a stand-in HTTP server on loopback, require no credentials and make no live call. Neither format has been run against a live service from this repository; the `riva` request is the one the TV channel's Magpie sidecar sends in production.
