import os
from pathlib import Path
from typing import Callable

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status

from .facecam import detect_facecam_regions
from .schemas import FacecamDetectionRequest, FacecamDetectionResponse


app = FastAPI(title="Disburse Media API")
app.state.facecam_detector = detect_facecam_regions
_ENV_LOADED = False


def _load_local_env() -> None:
    global _ENV_LOADED

    if _ENV_LOADED:
        return

    repo_root = Path(__file__).resolve().parents[3]
    load_dotenv(repo_root / ".env", override=False)
    _ENV_LOADED = True


def _get_media_api_secret() -> str:
    _load_local_env()
    secret = os.environ.get("MEDIA_API_SECRET", "").strip()
    if not secret:
        raise RuntimeError("MEDIA_API_SECRET environment variable is not set.")
    return secret


def authorize_internal_request(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {_get_media_api_secret()}"
    if authorization != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
        )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post(
    "/internal/facecam-detections",
    response_model=FacecamDetectionResponse,
    dependencies=[Depends(authorize_internal_request)],
)
def create_facecam_detection(
    payload: FacecamDetectionRequest,
    request: Request,
) -> FacecamDetectionResponse:
    detector: Callable[[FacecamDetectionRequest], FacecamDetectionResponse] = (
        request.app.state.facecam_detector
    )
    return detector(payload)
