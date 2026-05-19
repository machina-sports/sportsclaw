# =============================================================================
# SportsClaw × OpenShell — Sandbox Image
#
# A thin downstream image that adds the bits an OpenShell sandbox expects on
# top of the root SportsClaw container:
#   - a `sandbox` UNIX user (matches `process.run_as_user` in policy.yaml)
#   - writable /sandbox + /tmp (already present, just ensures ownership)
#   - a default entrypoint that loads the operate command
#
# Build from the repo root:
#   docker build -t sportsclaw-openshell:latest -f openshell/Dockerfile .
#
# Then create an OpenShell sandbox with it:
#   openshell sandbox create \
#       --from sportsclaw-openshell:latest \
#       --policy openshell/policy.yaml \
#       --name sportsclaw-tv
#
# The image is interchangeable with the root Dockerfile for any use that
# doesn't need the OpenShell-specific user setup, so external tenants who
# don't use OpenShell can ignore this file entirely.
# =============================================================================

# Base on the root sportsclaw image. Build the base image first:
#   docker build -t sportsclaw:latest .
ARG SPORTSCLAW_BASE=sportsclaw:latest
FROM ${SPORTSCLAW_BASE}

USER root

# Create the sandbox user OpenShell's default policy expects.
RUN groupadd -r sandbox && \
    useradd -r -g sandbox -d /sandbox -s /bin/bash sandbox && \
    mkdir -p /sandbox && \
    chown -R sandbox:sandbox /sandbox

# Daemon state under /app/.sportsclaw must be writable by the sandbox user
# so it can write briefs, editorial memory, and heartbeat persistence.
RUN chown -R sandbox:sandbox /app/.sportsclaw

USER sandbox
WORKDIR /sandbox

# Same entrypoint as the root image — `sportsclaw` CLI. The launcher reads
# its config from ~/.sportsclaw/operator/<jobId>.json; mount the config
# into the sandbox via `openshell sandbox upload` or bind the path at
# sandbox create time.
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["operate", "--list"]
