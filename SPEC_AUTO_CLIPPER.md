# SPEC: Auto-Clipper Plugin (WSC-Killer)

## 0. Implementation Status (V1 — highlights job API)

**Implemented** (see `src/highlights/*`, `docker/relay/highlights_jobs.py`):
- Deterministic highlights core with typed contracts: rights authorization,
  local-file source reference, canonical event identity, real PBP actions with
  provenance, fixed video sync anchor, pre/post-roll + candidate limits,
  candidate windows, clip manifest with ffprobe evidence, and job state.
- PBP→video mapping via a fixed sync anchor. Only `elapsed-ascending` clocks
  are supported; other clock semantics are rejected explicitly. Mocked or
  evenly-spaced timestamp selection has been removed entirely.
- Candidate windows are considered in deterministic primary order (importance,
  action time, then ID). Only remaining actions that directly overlap that
  primary by at least 90% of the shorter window are coalesced; overlap chains
  are not merged transitively. `mergedActions` is an optional additive V1 field:
  it is omitted for single-action windows and clips, and coalesced outputs
  include the primary plus every attached action with full provenance. The
  emitted coalesced bounds are the union of all attached windows, preserving
  every action's requested pre/post-roll context.
- Clips are accurately re-encoded to H.264/AAC instead of stream-copied, so
  sparse source keyframes cannot extend the requested window. Audio is retained
  when present. FFprobe evidence additively reports optional
  `videoDurationSec` and `audioDurationSec`; extraction fails closed if video
  duration is unavailable or differs from the request by more than 0.5 seconds,
  and manifest `durationSec` is the measured video-stream duration.
- FFmpeg streams fragmented MP4 to Node instead of writing the output path.
  Node checks each chunk before writing it, kills FFmpeg on the first chunk that
  would exceed the remaining exact byte budget, and removes the partial. Source
  file size/average bitrate and FFmpeg's packet-granular `-fs` are not used to
  enforce the cap.
- `sportsclaw highlights run --request <json> --output <json>` — the typed
  entrypoint the relay job API invokes.
- `sportsclaw clip` refactored as an adapter over the same core: it collects
  real PBP/rights/sync inputs (wizard prompts or `--request`), and fails with
  an actionable error when they cannot be provided.
- Relay async job API: `POST /api/highlights/jobs`, status, cancel, artifacts
  (see README_RELAY.md). FFmpeg/FFprobe installed in the relay image.

**Deferred — specified below but NOT implemented in V1:**
- Gemini Vision hype scoring / ranking (§10) and Gemini OCR smart sync (§8);
  V1 requires an explicit sync anchor instead.
- YOLOv8 vertical 9:16 auto-tracking (§2, §5); V1 is landscape cut-only.
- ffmpeg auto-installation wizard (§3); V1 fails closed when FFmpeg is missing.
- Signed-URL/object-store media download, HLS/live ingest, and publishing.

## 1. Objective
Build an optional plugin for `sportsclaw` that provides automated, computer-vision driven video clipping and 9:16 auto-tracking, completely bypassing the need for expensive legacy enterprise software.

## 2. Core Architecture
- **Opt-in modularity:** Kept out of the core bundle to keep `sportsclaw` lightweight.
- **Command:** `sportsclaw plugin install auto-clipper`
- **Dependencies:** 
  - Node: `onnxruntime-node`, `fluent-ffmpeg`.
  - System: `ffmpeg` binary.
  - Assets: Lightweight YOLOv8 Nano ONNX model (~6MB) downloaded to `~/.sportsclaw/models/`.

## 3. The Installation Wizard (Dev & Agent Experience)
The installer must be best-in-class for both human developers and autonomous AI agents:
1. **System Check:** Detect if `ffmpeg` is installed in the system PATH.
2. **Auto-Installation:** If missing, DO NOT just tell the user to install it. The wizard must ask: "ffmpeg is missing. Would you like SportsClaw to install it for you? (y/N)".
   - *Mac:* run `brew install ffmpeg`
   - *Linux:* run `apt-get install ffmpeg`
   - *Note:* Output a message if a terminal restart is required to refresh the PATH.
3. **Agentic Mode (Non-Interactive):** The CLI MUST support a `--yes` or `--non-interactive` flag. If this flag is passed, it assumes "yes" to all prompts (auto-installs ffmpeg, downloads models) without blocking on stdin. This ensures AI coding agents can use `sportsclaw` without hanging.

## 4. Engineering Tasks for Forge
1. Scaffold the `sportsclaw plugin` CLI router.
2. Build the `install auto-clipper` command with the interactive prompt and `--yes` override.
3. Implement the dependency checker (`which ffmpeg`) and auto-installer functions.
4. Implement the model downloader (fetches the ONNX model to the local cache).
5. Ensure the code follows strict TypeScript guidelines and error handling.

## 5. Output Formats (Landscape vs Vertical)
The `auto-clipper` MUST support dual output modes:
1. **Original Ratio (Landscape):** Just cut the video based on the PBP event timestamps (e.g., T-5s to T+3s) and keep the original 16:9 broadcast ratio. Fast and simple.
2. **Auto-Track (Vertical):** Cut the video AND run the YOLOv8 tracking to crop to 9:16 vertical format (TikTok/Reels), keeping the tracked subject in the center.

## 6. Global Agentic Flag
The `--yes` (or `--non-interactive`) flag MUST NOT be isolated to just this plugin. It must be implemented globally across the entire `sportsclaw` CLI harness so that AI agents can run *any* setup, install, or config command autonomously without hanging on stdin prompts.

## 7. Multi-Provider LLM Authentication
The `sportsclaw` engine MUST support a multi-provider credential keychain (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` stored concurrently). 
Since the `auto-clipper` plugin strictly relies on Gemini's multimodal vision capabilities:
- If the user's primary/active LLM in `sportsclaw` is already Gemini, proceed seamlessly.
- If the user is running Claude/OpenAI and triggers the clipper, the CLI MUST intercept the execution and prompt: "Auto-Clipper requires Gemini Vision models. Please authenticate with a Gemini API key to continue." It then securely stores this key alongside their existing provider keys.

## 8. "Smart" Local File Sync (Zero-Input)
Users should NOT have to manually provide a `--sync-start` offset. 
Instead, the CLI utilizes **Gemini Vision OCR**:
1. It extracts a few sampled frames from the first 10 minutes of the video.
2. It passes them to Gemini with the prompt: *"Read the on-screen broadcast scorebug. Find the exact video timestamp where the match clock starts (e.g., 00:00 for Q1/H1)."*
3. Gemini returns the exact video timestamp of kickoff/tip-off.
4. The engine automatically maps this anchor point to the Play-by-Play (PBP) data API timestamps. 
Result: The user simply runs `sportsclaw clip ./match.mp4 --match-id epl_9876 --query "All goals"`, and the engine handles the temporal alignment autonomously.

## 9. Conversational CLI Wizard (The "Magic" DX)
The developer experience must be conversational and intuitive. Instead of forcing developers to pass exact flags (e.g., `--match-id epl_9876 --file ./match.mp4`), the CLI must guide them via a natural language flow:
1. **Match Selection:** 
   - *CLI:* "What match are you clipping?"
   - *Dev:* "Corinthians vs Flamengo last week"
   - *CLI action:* Invokes local `sports-skills` endpoints (e.g., ESPN public APIs) to fetch recent schedules and match IDs without relying on centralized Machina APIs.
2. **File Selection:** 
   - *CLI:* "Where is the video file?"
   - *Dev:* Provides the local path (with tab-autocomplete support).
3. **Highlight Intent:** 
   - *CLI:* "What do you want to highlight?"
   - *Dev:* "Give me Memphis Depay's best moments"
   - *CLI action:* Passes this query to the LLM to filter the PBP data for high-leverage events matching the intent.

## 10. Gemini 1.5 Pro Multimodal Parity
To achieve state-of-the-art multimodal extraction, we cannot just use frame-by-frame image sampling. We must leverage Gemini 1.5 Pro's native Video + Audio understanding capabilities.
- **Native Video Ingestion:** Instead of manually extracting frames with FFmpeg for OCR/Syncing, we upload the raw video chunks natively to the Gemini File API (which supports up to 1-hour video contexts).
- **Audio-Visual "Hype" Scoring:** Legacy clipping is visually blind. To find a player's "best moments", the prompt to Gemini must combine the PBP event timestamp with a multi-modal instruction: *"Analyze this video segment. Focus on player #10 (Depay). Cross-reference his physical actions (dribbles, shots) with spikes in the audio track (crowd noise/announcer excitement) to assign a 'Hype Score' from 1-10. Only clip moments scoring 7+."*
- This approach bridges the gap between structured data (PBP) and unstructured multi-modal reality (video action + audio crowd context), achieving Twelve Labs-level semantic extraction without needing a dedicated video foundational model.
