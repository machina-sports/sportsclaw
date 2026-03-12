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
