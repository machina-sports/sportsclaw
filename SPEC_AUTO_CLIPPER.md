# SPEC: Auto-Clipper Plugin (WSC-Killer)

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

## 10. Gemini 1.5 Pro "Twelve Labs" Parity
To rival specialized multimodal engines like Twelve Labs, we cannot just use frame-by-frame image sampling. We must leverage Gemini 1.5 Pro's native Video + Audio understanding capabilities.
- **Native Video Ingestion:** Instead of manually extracting frames with FFmpeg for OCR/Syncing, we upload the raw video chunks natively to the Gemini File API (which supports up to 1-hour video contexts).
- **Audio-Visual "Hype" Scoring:** Legacy clipping is visually blind. To find a player's "best moments", the prompt to Gemini must combine the PBP event timestamp with a multi-modal instruction: *"Analyze this video segment. Focus on player #10 (Depay). Cross-reference his physical actions (dribbles, shots) with spikes in the audio track (crowd noise/announcer excitement) to assign a 'Hype Score' from 1-10. Only clip moments scoring 7+."*
- This approach bridges the gap between structured data (PBP) and unstructured multi-modal reality (video action + audio crowd context), achieving Twelve Labs-level semantic extraction without needing a dedicated video foundational model.
