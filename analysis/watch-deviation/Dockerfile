# Local analysis container: same arch (linux/arm64) and the same locked Python
# 3.10 / NumPy / SciPy as the pod's piezo-processor, so waveform replays match
# the pod without running anything on it.
FROM node:24-bookworm
ENV PNPM_HOME=/pnpm npm_config_store_dir=/pnpm/store PATH=/pnpm:/root/.local/bin:$PATH UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_LINK_MODE=copy TZ=UTC
RUN corepack enable && curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.10
WORKDIR /work
# The repo is bind-mounted at /work. node_modules and the venv live in named
# volumes so the host's macOS builds are never used inside Linux.
COPY setup.sh /usr/local/bin/sp-analysis-setup
ENTRYPOINT ["/bin/bash", "-c", "sp-analysis-setup >/dev/null && exec \"$0\" \"$@\""]
CMD ["bash"]
