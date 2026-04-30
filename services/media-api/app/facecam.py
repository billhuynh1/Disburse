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


def _clamp_box(box: _DetectedBox, frame_width: int, frame_height: int) -> _DetectedBox:
    x = max(0, min(box.x, frame_width - 1))
    y = max(0, min(box.y, frame_height - 1))
    width = max(1, min(box.width, frame_width - x))
    height = max(1, min(box.height, frame_height - y))

    return _DetectedBox(
        x=x,
        y=y,
        width=width,
        height=height,
        confidence=box.confidence,
    )


def _fallback_facecam_container(
    face_box: _DetectedBox,
    frame_width: int,
    frame_height: int,
) -> _DetectedBox:
    face_center_x = face_box.x + face_box.width / 2
    face_center_y = face_box.y + face_box.height / 2
    width = min(frame_width, round(face_box.width * 2.4))
    height = min(frame_height, round(face_box.height * 2.5))

    return _clamp_box(
        _DetectedBox(
            x=round(face_center_x - width / 2),
            y=round(face_center_y + face_box.height * 0.25 - height / 2),
            width=width,
            height=height,
            confidence=face_box.confidence * 0.92,
        ),
        frame_width,
        frame_height,
    )


def _edge_strength(edges, box: _DetectedBox) -> float:
    import numpy as np

    x1 = max(0, box.x)
    y1 = max(0, box.y)
    x2 = min(edges.shape[1] - 1, box.x + box.width)
    y2 = min(edges.shape[0] - 1, box.y + box.height)

    if x2 <= x1 or y2 <= y1:
        return 0.0

    samples = [
        edges[y1, x1:x2],
        edges[y2, x1:x2],
        edges[y1:y2, x1],
        edges[y1:y2, x2],
    ]

    return float(np.mean([sample.mean() for sample in samples if sample.size > 0]))


def _top_positions(strengths, start: int, stop: int, count: int) -> list[int]:
    import numpy as np

    if stop <= start:
        return []

    window = strengths[start:stop]
    if window.size == 0:
        return []

    threshold = max(float(np.percentile(window, 88)), float(window.mean() * 1.4), 10.0)
    positions = [
        start + index
        for index, value in enumerate(window)
        if float(value) >= threshold
    ]
    positions.sort(key=lambda position: float(strengths[position]), reverse=True)

    selected: list[int] = []
    for position in positions:
        if all(abs(position - existing) >= 8 for existing in selected):
            selected.append(position)
        if len(selected) >= count:
            break

    return selected


def _is_plausible_container(
    box: _DetectedBox,
    face_box: _DetectedBox,
    frame_width: int,
    frame_height: int,
) -> bool:
    box_area = box.width * box.height
    face_area = face_box.width * face_box.height
    frame_area = frame_width * frame_height
    aspect_ratio = box.width / box.height

    if box_area < face_area * 2.0 or box_area > frame_area * 0.45:
        return False

    if aspect_ratio < 0.45 or aspect_ratio > 2.4:
        return False

    if face_box.x < box.x or face_box.y < box.y:
        return False

    if face_box.x + face_box.width > box.x + box.width:
        return False

    if face_box.y + face_box.height > box.y + box.height:
        return False

    return True


def _score_container(edges, box: _DetectedBox, face_box: _DetectedBox) -> float:
    face_area = face_box.width * face_box.height
    box_area = box.width * box.height
    size_ratio = min(box_area / max(face_area, 1), 8.0) / 8.0
    edge_score = _edge_strength(edges, box) / 255.0

    return edge_score * 0.7 + size_ratio * 0.3


def _candidate_from_anchor(
    face_box: _DetectedBox,
    frame_width: int,
    frame_height: int,
    aspect_ratio: float,
    face_width_fraction: float,
    face_center_x_fraction: float,
    face_center_y_fraction: float,
) -> _DetectedBox:
    face_center_x = face_box.x + face_box.width / 2
    face_center_y = face_box.y + face_box.height / 2
    width = round(face_box.width / face_width_fraction)
    height = round(width / aspect_ratio)

    if height < face_box.height * 1.9:
        height = round(face_box.height * 2.2)
        width = round(height * aspect_ratio)

    return _clamp_box(
        _DetectedBox(
            x=round(face_center_x - width * face_center_x_fraction),
            y=round(face_center_y - height * face_center_y_fraction),
            width=width,
            height=height,
            confidence=face_box.confidence,
        ),
        frame_width,
        frame_height,
    )


def _infer_facecam_container(
    frame,
    face_box: _DetectedBox,
    frame_width: int,
    frame_height: int,
) -> _DetectedBox:
    try:
        import cv2
    except ImportError:
        return _fallback_facecam_container(face_box, frame_width, frame_height)

    fallback = _fallback_facecam_container(face_box, frame_width, frame_height)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 140)
    vertical_strength = edges.mean(axis=0)
    horizontal_strength = edges.mean(axis=1)
    face_margin_x = max(8, round(face_box.width * 0.2))
    face_margin_y = max(8, round(face_box.height * 0.2))
    search_padding_x = max(round(face_box.width * 2.5), round(frame_width * 0.08))
    search_padding_y = max(round(face_box.height * 2.2), round(frame_height * 0.08))
    search_left = max(0, face_box.x - search_padding_x)
    search_right = min(frame_width - 1, face_box.x + face_box.width + search_padding_x)
    search_top = max(0, face_box.y - search_padding_y)
    search_bottom = min(frame_height - 1, face_box.y + face_box.height + search_padding_y)
    left_positions = _top_positions(
        vertical_strength,
        search_left,
        max(search_left + 1, face_box.x - face_margin_x),
        4,
    )
    right_positions = _top_positions(
        vertical_strength,
        min(search_right, face_box.x + face_box.width + face_margin_x),
        search_right,
        4,
    )
    top_positions = _top_positions(
        horizontal_strength,
        search_top,
        max(search_top + 1, face_box.y - face_margin_y),
        4,
    )
    bottom_positions = _top_positions(
        horizontal_strength,
        min(search_bottom, face_box.y + face_box.height + face_margin_y),
        search_bottom,
        4,
    )
    candidates: list[_DetectedBox] = [fallback]

    for left in left_positions:
        for right in right_positions:
            for top in top_positions:
                for bottom in bottom_positions:
                    candidates.append(
                        _clamp_box(
                            _DetectedBox(
                                x=left,
                                y=top,
                                width=right - left,
                                height=bottom - top,
                                confidence=face_box.confidence,
                            ),
                            frame_width,
                            frame_height,
                        )
                    )

    for aspect_ratio in (16 / 9, 4 / 3, 1.0, 3 / 4):
        for face_width_fraction in (0.32, 0.4, 0.5):
            for center_x_fraction in (0.45, 0.5, 0.55):
                for center_y_fraction in (0.38, 0.45, 0.52):
                    candidates.append(
                        _candidate_from_anchor(
                            face_box,
                            frame_width,
                            frame_height,
                            aspect_ratio,
                            face_width_fraction,
                            center_x_fraction,
                            center_y_fraction,
                        )
                    )

    plausible = [
        candidate
        for candidate in candidates
        if _is_plausible_container(candidate, face_box, frame_width, frame_height)
    ]

    if not plausible:
        return fallback

    best = max(plausible, key=lambda candidate: _score_container(edges, candidate, face_box))
    best_score = _score_container(edges, best, face_box)
    fallback_score = _score_container(edges, fallback, face_box)

    if best_score < 0.18 or best_score < fallback_score * 1.1:
        return fallback

    return best



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
                    face_box = _to_pixel_box(
                        relative_box,
                        frame_width,
                        frame_height,
                        confidence,
                    )
                    boxes.append(
                        _infer_facecam_container(frame, face_box, frame_width, frame_height)
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
