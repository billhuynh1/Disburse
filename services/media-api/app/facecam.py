from __future__ import annotations

from dataclasses import dataclass
import ssl
from pathlib import Path
import tempfile
from urllib.request import Request, urlopen

import certifi

from .schemas import (
    FacecamCandidate,
    FacecamDetectionRequest,
    FacecamDetectionResponse,
)


@dataclass
class _DetectedBox:
    x: int
    y: int
    width: int
    height: int
    confidence: float


@dataclass
class _BoxCluster:
    boxes: list[_DetectedBox]

    @property
    def representative(self) -> _DetectedBox:
        total_weight = sum(max(box.confidence, 0.01) for box in self.boxes)
        x = round(sum(box.x * max(box.confidence, 0.01) for box in self.boxes) / total_weight)
        y = round(sum(box.y * max(box.confidence, 0.01) for box in self.boxes) / total_weight)
        width = round(
            sum(box.width * max(box.confidence, 0.01) for box in self.boxes) / total_weight
        )
        height = round(
            sum(box.height * max(box.confidence, 0.01) for box in self.boxes) / total_weight
        )
        confidence = sum(box.confidence for box in self.boxes) / len(self.boxes)
        return _DetectedBox(x=x, y=y, width=width, height=height, confidence=confidence)

    @property
    def score(self) -> tuple[int, float]:
        return (len(self.boxes), self.representative.confidence)


def _download_to_temp_file(download_url: str, source_filename: str) -> str:
    suffix = Path(source_filename).suffix or ".mp4"
    temp_file = tempfile.NamedTemporaryFile(prefix="disburse-facecam-", suffix=suffix, delete=False)
    temp_path = temp_file.name
    ssl_context = ssl.create_default_context(cafile=certifi.where())

    try:
        with temp_file:
            request = Request(download_url, headers={"User-Agent": "DisburseMediaAPI/1.0"})
            with urlopen(request, timeout=60, context=ssl_context) as response:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    temp_file.write(chunk)
        return temp_path
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise


def _intersection_over_union(left: _DetectedBox, right: _DetectedBox) -> float:
    left_x2 = left.x + left.width
    left_y2 = left.y + left.height
    right_x2 = right.x + right.width
    right_y2 = right.y + right.height

    intersection_width = max(0, min(left_x2, right_x2) - max(left.x, right.x))
    intersection_height = max(0, min(left_y2, right_y2) - max(left.y, right.y))
    intersection_area = intersection_width * intersection_height

    left_area = left.width * left.height
    right_area = right.width * right.height
    union_area = left_area + right_area - intersection_area

    if union_area <= 0:
        return 0.0

    return intersection_area / union_area


def _cluster_boxes(boxes: list[_DetectedBox]) -> list[_BoxCluster]:
    clusters: list[_BoxCluster] = []

    for box in boxes:
        best_cluster: _BoxCluster | None = None
        best_iou = 0.0

        for cluster in clusters:
            iou = _intersection_over_union(box, cluster.representative)
            if iou > best_iou:
                best_iou = iou
                best_cluster = cluster

        if best_cluster and best_iou >= 0.25:
            best_cluster.boxes.append(box)
        else:
            clusters.append(_BoxCluster(boxes=[box]))

    return sorted(clusters, key=lambda cluster: cluster.score, reverse=True)


def _to_pixel_box(relative_box, frame_width: int, frame_height: int, confidence: float):
    x = max(0, round(relative_box.xmin * frame_width))
    y = max(0, round(relative_box.ymin * frame_height))
    width = max(1, round(relative_box.width * frame_width))
    height = max(1, round(relative_box.height * frame_height))

    if x + width > frame_width:
        width = max(1, frame_width - x)
    if y + height > frame_height:
        height = max(1, frame_height - y)

    return _DetectedBox(
        x=x,
        y=y,
        width=width,
        height=height,
        confidence=confidence,
    )


def detect_facecam_regions(
    request: FacecamDetectionRequest,
) -> FacecamDetectionResponse:
    try:
        import cv2
        import mediapipe as mp
    except ImportError as error:
        raise RuntimeError("Media analysis dependencies are not installed.") from error

    video_path = _download_to_temp_file(str(request.sourceDownloadUrl), request.sourceFilename)
    capture = None

    try:
        capture = cv2.VideoCapture(video_path)
        if not capture.isOpened():
            raise RuntimeError("Source video could not be opened for facecam detection.")

        frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))

        if frame_width <= 0 or frame_height <= 0:
            raise RuntimeError("Source video dimensions could not be read.")

        boxes: list[_DetectedBox] = []
        sampled_frame_count = 0

        with mp.solutions.face_detection.FaceDetection(
            model_selection=1,
            min_detection_confidence=0.5,
        ) as detector:
            for time_ms in range(
                request.startTimeMs,
                request.endTimeMs,
                request.samplingIntervalMs,
            ):
                capture.set(cv2.CAP_PROP_POS_MSEC, time_ms)
                ok, frame = capture.read()

                if not ok:
                    continue

                sampled_frame_count += 1
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = detector.process(rgb_frame)

                for detection in result.detections or []:
                    relative_box = detection.location_data.relative_bounding_box
                    confidence = float(detection.score[0]) if detection.score else 0.0
                    boxes.append(
                        _to_pixel_box(relative_box, frame_width, frame_height, confidence)
                    )

        clusters = _cluster_boxes(boxes)
        candidates: list[FacecamCandidate] = []

        for index, cluster in enumerate(clusters[: request.maxCandidateBoxes], start=1):
            representative = cluster.representative
            candidates.append(
                FacecamCandidate(
                    rank=index,
                    xPx=representative.x,
                    yPx=representative.y,
                    widthPx=representative.width,
                    heightPx=representative.height,
                    confidence=max(0, min(100, round(representative.confidence * 100))),
                )
            )

        return FacecamDetectionResponse(
            frameWidth=frame_width,
            frameHeight=frame_height,
            sampledFrameCount=sampled_frame_count,
            candidates=candidates,
        )
    finally:
        if capture is not None:
            capture.release()
        Path(video_path).unlink(missing_ok=True)
