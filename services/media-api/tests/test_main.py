from pathlib import Path

from fastapi.testclient import TestClient

from app import facecam
from app.facecam import detect_facecam_regions
from app.main import app
from app.schemas import FacecamDetectionResponse


def _client(monkeypatch):
    monkeypatch.setenv("MEDIA_API_SECRET", "test-secret")
    app.state.facecam_detector = detect_facecam_regions
    return TestClient(app)


def _payload():
    return {
        "sourceDownloadUrl": "https://example.com/source.mp4",
        "sourceFilename": "source.mp4",
        "startTimeMs": 1000,
        "endTimeMs": 5000,
    }


def test_health() -> None:
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_facecam_detection_requires_authorization(monkeypatch) -> None:
    client = _client(monkeypatch)
    response = client.post("/internal/facecam-detections", json=_payload())
    assert response.status_code == 401


def test_facecam_detection_rejects_invalid_timing(monkeypatch) -> None:
    client = _client(monkeypatch)
    payload = {
        **_payload(),
        "startTimeMs": 5000,
        "endTimeMs": 1000,
    }
    response = client.post(
        "/internal/facecam-detections",
        headers={"Authorization": "Bearer test-secret"},
        json=payload,
    )
    assert response.status_code == 422


def test_facecam_detection_no_face_result(monkeypatch) -> None:
    client = _client(monkeypatch)

    def detector(_payload):
        return FacecamDetectionResponse(
            frameWidth=1920,
            frameHeight=1080,
            sampledFrameCount=4,
            candidates=[],
        )

    app.state.facecam_detector = detector
    response = client.post(
        "/internal/facecam-detections",
        headers={"Authorization": "Bearer test-secret"},
        json=_payload(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "frameWidth": 1920,
        "frameHeight": 1080,
        "sampledFrameCount": 4,
        "candidates": [],
        "detectionStage": None,
        "debugSummary": None,
    }


def test_facecam_detection_returns_ranked_candidates(monkeypatch) -> None:
    client = _client(monkeypatch)

    def detector(_payload):
        return FacecamDetectionResponse(
            frameWidth=1920,
            frameHeight=1080,
            sampledFrameCount=3,
            candidates=[
                {
                    "rank": 1,
                    "xPx": 1400,
                    "yPx": 120,
                    "widthPx": 360,
                    "heightPx": 360,
                    "confidence": 92,
                }
            ],
        )

    app.state.facecam_detector = detector
    response = client.post(
        "/internal/facecam-detections",
        headers={"Authorization": "Bearer test-secret"},
        json={**_payload(), "samplingIntervalMs": 500, "maxCandidateBoxes": 1},
    )

    assert response.status_code == 200
    assert response.json()["candidates"] == [
        {
            "rank": 1,
            "xPx": 1400,
            "yPx": 120,
            "widthPx": 360,
            "heightPx": 360,
            "confidence": 92,
        }
    ]
    assert response.json()["detectionStage"] is None
    assert response.json()["debugSummary"] is None


def test_facecam_download_uses_certifi_ssl_context(monkeypatch) -> None:
    captured = {}
    ssl_context = object()

    class Response:
        def __init__(self) -> None:
            self.chunks = [b"video-bytes", b""]

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self, _size: int) -> bytes:
            return self.chunks.pop(0)

    def create_default_context(*, cafile: str):
        captured["cafile"] = cafile
        return ssl_context

    def open_url(request, *, timeout: int, context):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["context"] = context
        return Response()

    monkeypatch.setattr(facecam.certifi, "where", lambda: "/tmp/certifi.pem")
    monkeypatch.setattr(facecam.ssl, "create_default_context", create_default_context)
    monkeypatch.setattr(facecam, "urlopen", open_url)

    path = facecam._download_to_temp_file("https://example.com/source.mp4", "source.mp4")

    try:
        assert Path(path).read_bytes() == b"video-bytes"
    finally:
        Path(path).unlink(missing_ok=True)

    assert captured == {
        "cafile": "/tmp/certifi.pem",
        "url": "https://example.com/source.mp4",
        "timeout": 60,
        "context": ssl_context,
    }
