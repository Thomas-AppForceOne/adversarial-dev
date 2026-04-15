FROM oven/bun:1-debian

# System deps that agents commonly need when building/testing projects.
# Kept minimal — add more if your stack needs them (e.g. java, ruby, rust).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        python3 \
        python3-pip \
        python3-venv \
        build-essential \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/*

# Install the real Claude Code CLI. The harness spawns `claude -p` for
# every planner/generator/evaluator turn; using the official binary means
# Anthropic sees legitimate Claude Code traffic (no OAuth impersonation,
# no ToS grey area), and token refresh is handled by Claude Code itself.
RUN npm install -g @anthropic-ai/claude-code \
    && claude --version

# The oven/bun image ships with a non-root `bun` user (uid 1000). We run
# the harness as that user so claude-cli's root-safety check doesn't
# reject `--dangerously-skip-permissions`. Pre-create the directories
# we'll need and chown them so bind mounts land with the right owner.
RUN mkdir -p /harness /harness/workspace /project /home/bun/.claude \
 && chown -R bun:bun /harness /project /home/bun/.claude

WORKDIR /harness
USER bun

# Install JS dependencies first so they cache across source changes
COPY --chown=bun:bun package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy harness source
COPY --chown=bun:bun shared ./shared
COPY --chown=bun:bun claude-harness ./claude-harness
COPY --chown=bun:bun codex-harness ./codex-harness

# Default to claude harness; override with:
#   docker run ... adversarial-dev codex-harness/index.ts <args>
ENTRYPOINT ["bun", "run"]
CMD ["claude-harness/index.ts"]
