"""The commit a run builds from (#481): the workflow's GITHUB_SHA, else the checkout's HEAD."""

from __future__ import annotations

import os
import subprocess


def git_sha(fallback: str = "unknown") -> str:
    """GITHUB_SHA in a workflow, else `git rev-parse HEAD`, else ``fallback`` outside a checkout."""
    env_sha = os.environ.get("GITHUB_SHA")
    if env_sha:
        return env_sha
    proc = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    return proc.stdout.strip() or fallback
