import json
import logging
import os
import re
import traceback

LOGGER = logging.getLogger("disburse.media")
TRACEBACK_LIMIT = 8192
MESSAGE_LIMIT = 1024
FRAME_LIMIT = 768
SECRET_KEY = re.compile(r"secret|token|password|api_?key|access_?key|authorization|postgres_url|database_url", re.I)
URL = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s<>\"']+", re.I)
AUTHORIZATION = re.compile(r"\b(Bearer|Basic)\s+[^\s,\"'<>]+", re.I)
CREDENTIAL = re.compile(r"\b(?=[\w-]*(?:secret|token|password|api[_-]?key|access[_-]?key|signature|credential|authorization))([\w-]+)([\"']?\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;&<>]+)", re.I)


def redact_diagnostic(text: str) -> str:
    secrets = sorted((value for key, value in os.environ.items()
                      if SECRET_KEY.search(key) and value), key=len, reverse=True)
    for secret in secrets:
        text = text.replace(secret, "[REDACTED]")
    text = URL.sub("[URL REDACTED]", text)
    text = AUTHORIZATION.sub(r"\1 [REDACTED]", text)
    return CREDENTIAL.sub(r"\1\2[REDACTED]", text)


def log_facecam_failure(error: Exception, payload) -> None:
    # Never attach exc_info: Uvicorn/logging would format the raw exception again.
    try:
        chain = []
        seen = set()
        current = error
        def safe_text(text):
            safe = redact_diagnostic(text)
            return safe.replace(payload.sourceFilename, "[FILENAME REDACTED]") if payload.sourceFilename else safe

        while current is not None and id(current) not in seen and len(chain) < 4:
            seen.add(id(current))
            frames = traceback.extract_tb(current.__traceback__)
            # Frame locations identify the failing code without logging source lines or locals.
            locations = "".join(f'  File "{frame.filename}", line {frame.lineno}, in {frame.name}\n'
                                for frame in frames)
            # Bound each cause separately so a long wrapper cannot hide the root cause.
            message = safe_text(str(current))[:MESSAGE_LIMIT]
            name = safe_text(type(current).__name__)[:80]
            chain.append(f"{name}: {message}\n{safe_text(locations)[-FRAME_LIMIT:]}")
            current = current.__cause__ or (None if current.__suppress_context__ else current.__context__)
        safe = "\nCaused by:\n".join(chain)
        LOGGER.error(json.dumps({
            "event": "media.facecam_failure",
            "detectorVersion": payload.detectorVersion,
            "startTimeMs": payload.startTimeMs,
            "endTimeMs": payload.endTimeMs,
            "traceback": safe[:TRACEBACK_LIMIT],
        }))
    except Exception:
        pass
