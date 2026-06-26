"""
CAPTCHA Handler Module

Shared CAPTCHA detection and human-in-the-loop solving for browser-based
security testing skills. Detects CAPTCHAs during pentesting, pauses for
human solving via visible browser, saves session state, and resumes scanning.

Supported CAPTCHA types: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile,
GeeTest, FunCaptcha, and custom implementations.
"""

from common.captcha.captcha_handler import CaptchaDetector, CaptchaHandler, CaptchaType
from common.captcha.session_store import SessionStore

__all__ = ["CaptchaDetector", "CaptchaHandler", "CaptchaType", "SessionStore"]
