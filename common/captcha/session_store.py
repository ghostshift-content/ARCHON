"""
Session Store for CAPTCHA Handler

Persists browser session state (cookies, localStorage, sessionStorage) after
human CAPTCHA solving so sessions can be restored across scan phases without
re-solving. Sessions are stored as JSON files with configurable TTL.
"""

import hashlib
import json
import os
import time
from urllib.parse import urlparse


class SessionStore:
    """
    Manages persistent session storage for post-CAPTCHA browser sessions.

    Sessions are saved per-domain under {store_dir}/{context_name}/{domain_hash}.json.
    Each session file contains cookies, localStorage, sessionStorage, and metadata
    including creation time for TTL-based expiry.

    NOTE: This class is designed to work WITH Claude Code's Playwright MCP integration.
    Claude Code extracts session data via Playwright and passes it here for persistence.
    """

    DEFAULT_TTL_SECONDS = 4 * 60 * 60  # 4 hours

    def __init__(self, store_dir=None, ttl_seconds=None):
        """
        Initialize SessionStore.

        Args:
            store_dir: Directory for session files. Defaults to
                       common/captcha/.sessions/ relative to this file.
            ttl_seconds: Session time-to-live in seconds. Defaults to 4 hours.
        """
        if store_dir is None:
            store_dir = os.path.join(os.path.dirname(__file__), ".sessions")
        self.store_dir = store_dir
        self.ttl_seconds = ttl_seconds or self.DEFAULT_TTL_SECONDS

    def _domain_hash(self, url):
        """Generate a short hash from the URL's domain for filename safety."""
        domain = urlparse(url).netloc
        return hashlib.sha256(domain.encode()).hexdigest()[:16]

    def _session_path(self, url, context_name):
        """Return the file path for a session."""
        domain_hash = self._domain_hash(url)
        return os.path.join(self.store_dir, context_name, f"{domain_hash}.json")

    def _ensure_dir(self, path):
        """Create parent directories if they don't exist."""
        os.makedirs(os.path.dirname(path), exist_ok=True)

    def save_session(self, target_url, context_name, cookies, local_storage=None,
                     session_storage=None):
        """
        Save session state to disk.

        Claude Code should call this after a human solves a CAPTCHA:
        1. Use Playwright MCP to extract cookies via context.cookies()
        2. Use page.evaluate() to read localStorage and sessionStorage
        3. Pass the data here for persistence

        Args:
            target_url: The URL the session is associated with.
            context_name: Scan context name (e.g., 'dast-scan-example-com').
            cookies: List of cookie dicts from Playwright context.cookies().
            local_storage: Dict of localStorage key-value pairs (optional).
            session_storage: Dict of sessionStorage key-value pairs (optional).

        Returns:
            Path to the saved session file.
        """
        path = self._session_path(target_url, context_name)
        self._ensure_dir(path)

        domain = urlparse(target_url).netloc
        session_data = {
            "domain": domain,
            "target_url": target_url,
            "context_name": context_name,
            "created_at": time.time(),
            "ttl_seconds": self.ttl_seconds,
            "cookies": cookies,
            "local_storage": local_storage or {},
            "session_storage": session_storage or {},
        }

        with open(path, "w") as f:
            json.dump(session_data, f, indent=2)

        return path

    def load_session(self, target_url, context_name):
        """
        Load session state from disk.

        Claude Code should call this before authentication to check if a valid
        session exists. If it does, restore it via Playwright MCP instead of
        re-authenticating and re-solving CAPTCHAs.

        Args:
            target_url: The URL the session is associated with.
            context_name: Scan context name.

        Returns:
            Session data dict, or None if no session file exists.
        """
        path = self._session_path(target_url, context_name)
        if not os.path.exists(path):
            return None

        with open(path, "r") as f:
            return json.load(f)

    def is_session_expired(self, target_url, context_name):
        """
        Check whether a saved session has exceeded its TTL.

        Args:
            target_url: The URL the session is associated with.
            context_name: Scan context name.

        Returns:
            True if the session is expired or doesn't exist, False if still valid.
        """
        session = self.load_session(target_url, context_name)
        if session is None:
            return True

        created_at = session.get("created_at", 0)
        ttl = session.get("ttl_seconds", self.ttl_seconds)
        return (time.time() - created_at) > ttl

    def delete_session(self, target_url, context_name):
        """
        Delete a saved session file.

        Args:
            target_url: The URL the session is associated with.
            context_name: Scan context name.

        Returns:
            True if the file was deleted, False if it didn't exist.
        """
        path = self._session_path(target_url, context_name)
        if os.path.exists(path):
            os.remove(path)
            return True
        return False

    def list_sessions(self, context_name=None):
        """
        List all saved sessions, optionally filtered by context.

        Args:
            context_name: If provided, only list sessions under this context.
                          If None, list all sessions across all contexts.

        Returns:
            List of dicts with session metadata and expiry status.
        """
        sessions = []

        if context_name:
            search_dir = os.path.join(self.store_dir, context_name)
            contexts = [context_name] if os.path.isdir(search_dir) else []
        else:
            if not os.path.isdir(self.store_dir):
                return sessions
            contexts = [
                d for d in os.listdir(self.store_dir)
                if os.path.isdir(os.path.join(self.store_dir, d))
            ]

        for ctx in contexts:
            ctx_dir = os.path.join(self.store_dir, ctx)
            for filename in os.listdir(ctx_dir):
                if not filename.endswith(".json"):
                    continue
                filepath = os.path.join(ctx_dir, filename)
                try:
                    with open(filepath, "r") as f:
                        data = json.load(f)
                    created_at = data.get("created_at", 0)
                    ttl = data.get("ttl_seconds", self.ttl_seconds)
                    expired = (time.time() - created_at) > ttl
                    sessions.append({
                        "context_name": ctx,
                        "domain": data.get("domain", "unknown"),
                        "target_url": data.get("target_url", ""),
                        "created_at": created_at,
                        "expired": expired,
                        "file": filepath,
                    })
                except (json.JSONDecodeError, OSError):
                    continue

        return sessions

    def cleanup_expired(self, context_name=None):
        """
        Remove all expired session files.

        Args:
            context_name: If provided, only clean up sessions under this context.
                          If None, clean up all expired sessions.

        Returns:
            Number of expired sessions removed.
        """
        removed = 0
        sessions = self.list_sessions(context_name)

        for session in sessions:
            if session["expired"]:
                try:
                    os.remove(session["file"])
                    removed += 1
                except OSError:
                    continue

        # Clean up empty context directories
        if context_name:
            ctx_dir = os.path.join(self.store_dir, context_name)
            if os.path.isdir(ctx_dir) and not os.listdir(ctx_dir):
                os.rmdir(ctx_dir)
        else:
            if os.path.isdir(self.store_dir):
                for d in os.listdir(self.store_dir):
                    ctx_dir = os.path.join(self.store_dir, d)
                    if os.path.isdir(ctx_dir) and not os.listdir(ctx_dir):
                        os.rmdir(ctx_dir)

        return removed
