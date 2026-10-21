# =============================================================================
# SportsClaw × OpenShell — Sandbox Image
#
# A thin downstream image that adds the bits an OpenShell sandbox expects on
# top of the root SportsClaw container:
#   - a non-root `sandbox` UNIX user (matches `process.run_as_user` in the policies)
#   - HOME=/sandbox, so operator configs live in /sandbox/.sportsclaw/operator
#   - writable /sandbox + /tmp (already present, just ensures ownership)
#
# Build from the repo root, then push to a registry the OpenShell gateway's
# container engine can pull from (`--from` takes an image reference, not a
# Dockerfile):
#   docker build -t sportsclaw:latest .
#   docker build -t <registry>/sportsclaw-openshell:<tag> -f openshell/Dockerfile .
#   docker push <registry>/sportsclaw-openshell:<tag>
#
# Then launch with the inference provider attached (OpenShell 0.1.5; full
# recipe: `sportsclaw openshell setup`):
#   openshell sandbox create --name sportsclaw-op \
#       --from <registry>/sportsclaw-openshell:<tag> \
#       --provider <provider> \
#       --policy openshell/policy.vault.yaml \
#       --upload ./<jobId>.json:/sandbox/.sportsclaw/operator/<jobId>.json \
#       --detach --restart-policy on-failure \
#       -- node /app/dist/index.js operate --job <jobId>
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
# Explicit: the operator reads ~/.sportsclaw/operator/<jobId>.json, and the
# runtime is not guaranteed to derive HOME from the image's passwd entry.
ENV HOME=/sandbox

# Same entrypoint as the root image — `sportsclaw` CLI. OpenShell runs the
# command given after `--` verbatim as the sandbox main process; upload the
# job config with `--upload` at sandbox create time.
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["operate", "--list"]
