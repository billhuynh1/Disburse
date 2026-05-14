from __future__ import annotations

import ssl
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import certifi

from .schemas import (
    FacecamCandidate,
    FacecamDetectionRequest,
    FacecamDetectionResponse,
)

MIN_ROI_DIMENSION = 400
MAX_ROI_DIMENSION = 720
CLUSTERING_IOU_THRESHOLD = 0.35
TEMPORAL_PERSISTENCE_THRESHOLD = 0.25
REGION_PRIOR_BOOST = 1.20
CENTER_FRAME_PENALTY = 0.55


@dataclass
class _DetectedBox:
    x: int
    y: int
    width: int
    height: int
    confidence: float
    frame_time_ms: int = -1
    source_region: str = "unknown"


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
    def unique_frame_count(self) -> int:
        return len({box.frame_time_ms for box in self.boxes if box.frame_time_ms >= 0})

    def persistence_score(self, total_frames: int) -> float:
        if total_frames <= 0:
            return 0.0
        return self.unique_frame_count / total_frames

    def ranking_score(self, total_frames: int) -> float:
        persistence = self.persistence_score(total_frames)
        avg_conf = self.representative.confidence
        return persistence * 0.6 + avg_conf * 0.4

    @property
    def score(self) -> tuple[int, float]:
        return (len(self.boxes), self.representative.confidence)


@dataclass
class _DetectionStageResult:
    stage_name: str
    sampling_interval_ms: int
    sampled_frame_count: int
    boxes: list[_DetectedBox]
    detector_used: str = "unknown"


@dataclass
class _DetectorRuntime:
    mediapipe_detectors: dict[tuple[int, float], Any] = field(default_factory=dict)

    def get_mediapipe_detector(self, model_selection: int, min_detection_confidence: float):
        key = (model_selection, min_detection_confidence)
        detector = self.mediapipe_detectors.get(key)
        if detector is not None:
            return detector

        import mediapipe as mp

        detector = mp.solutions.face_detection.FaceDetection(
            model_selection=model_selection,
            min_detection_confidence=min_detection_confidence,
        )
        self.mediapipe_detectors[key] = detector
        return detector

    def close(self) -> None:
        for detector in self.mediapipe_detectors.values():
            close = getattr(detector, "close", None)
            if callable(close):
                close()
        self.mediapipe_detectors.clear()


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


def _clamp_box(box: _DetectedBox, frame_width: int, frame_height: int) -> _DetectedBox:
    x = max(0, min(box.x, frame_width - 1))
    y = max(0, min(box.y, frame_height - 1))
    width = max(1, min(box.width, frame_width - x))
    height = max(1, min(box.height, frame_height - y))

    return _DetectedBox(
        x=x, y=y, width=width, height=height,
        confidence=box.confidence,
        frame_time_ms=box.frame_time_ms,
        source_region=box.source_region,
    )


def _to_pixel_box(
    relative_box, frame_width: int, frame_height: int, confidence: float,
    frame_time_ms: int = -1, source_region: str = "unknown",
) -> _DetectedBox:
    x = max(0, round(relative_box.xmin * frame_width))
    y = max(0, round(relative_box.ymin * frame_height))
    width = max(1, round(relative_box.width * frame_width))
    height = max(1, round(relative_box.height * frame_height))

    if x + width > frame_width:
        width = max(1, frame_width - x)
    if y + height > frame_height:
        height = max(1, frame_height - y)

    return _DetectedBox(
        x=x, y=y, width=width, height=height, confidence=confidence,
        frame_time_ms=frame_time_ms, source_region=source_region,
    )


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

        if best_cluster and best_iou >= CLUSTERING_IOU_THRESHOLD:
            best_cluster.boxes.append(box)
        else:
            clusters.append(_BoxCluster(boxes=[box]))

    return sorted(clusters, key=lambda cluster: cluster.score, reverse=True)


def _filter_clusters_by_persistence(
    clusters: list[_BoxCluster], total_frames: int
) -> list[_BoxCluster]:
    if total_frames <= 2:
        return clusters

    filtered = [
        cluster
        for cluster in clusters
        if cluster.persistence_score(total_frames) >= TEMPORAL_PERSISTENCE_THRESHOLD
    ]

    if not filtered:
        return clusters[:1]

    filtered.sort(key=lambda c: c.ranking_score(total_frames), reverse=True)
    return filtered


def _is_in_center_region(box: _DetectedBox, frame_width: int, frame_height: int) -> bool:
    """Check if a detection is in the center of the frame (game content area)."""
    center_x = box.x + box.width / 2
    center_y = box.y + box.height / 2

    x_margin = frame_width * 0.20
    y_margin = frame_height * 0.20

    return (
        x_margin < center_x < frame_width - x_margin
        and y_margin < center_y < frame_height - y_margin
    )


def _candidate_regions(frame_width: int, frame_height: int) -> list[tuple[str, tuple[int, int, int, int]]]:
    bottom_band_top = max(0, round(frame_height * 0.5))
    top_band_bottom = round(frame_height * 0.5)
    side_width = round(frame_width * 0.42)
    bottom_center_left = round(frame_width * 0.24)
    bottom_center_right = round(frame_width * 0.76)
    bottom_side_top = max(0, round(frame_height * 0.52))
    top_side_bottom = round(frame_height * 0.48)

    return [
        ("full_frame", (0, 0, frame_width, frame_height)),
        ("bottom_center", (bottom_center_left, bottom_band_top, bottom_center_right, frame_height)),
        ("bottom_left", (0, bottom_side_top, min(frame_width, side_width), frame_height)),
        ("bottom_right", (max(0, frame_width - side_width), bottom_side_top, frame_width, frame_height)),
        ("bottom_band", (0, bottom_band_top, frame_width, frame_height)),
        ("top_left", (0, 0, min(frame_width, side_width), top_side_bottom)),
        ("top_right", (max(0, frame_width - side_width), 0, frame_width, top_side_bottom)),
        ("top_band", (0, 0, frame_width, top_band_bottom)),
    ]


def _rescale_roi(
    roi,
    min_dimension: int = MIN_ROI_DIMENSION,
    max_dimension: int = MAX_ROI_DIMENSION,
):
    import cv2

    h, w = roi.shape[:2]
    min_current = min(h, w)
    max_current = max(h, w)

    if min_current >= min_dimension and max_current <= max_dimension:
        return roi, 1.0

    if min_current < min_dimension:
        scale = min_dimension / min_current
        interpolation = cv2.INTER_LINEAR
    else:
        scale = max_dimension / max_current
        interpolation = cv2.INTER_AREA

    resized = cv2.resize(roi, None, fx=scale, fy=scale, interpolation=interpolation)
    return resized, scale


def _detect_faces_mediapipe(
    frame, roi_offset_x: int, roi_offset_y: int,
    roi_width: int, roi_height: int,
    runtime: _DetectorRuntime,
    frame_time_ms: int, source_region: str,
) -> list[_DetectedBox]:
    import cv2

    try:
        import mediapipe as mp  # noqa: F401
    except ImportError:
        return []

    roi = frame
    roi, scale = _rescale_roi(roi)
    scaled_w = roi.shape[1]
    scaled_h = roi.shape[0]

    rgb_frame = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)
    boxes: list[_DetectedBox] = []

    detector_configs = [
        {"model_selection": 1, "min_detection_confidence": 0.45},
        {"model_selection": 0, "min_detection_confidence": 0.30},
    ]

    for config in detector_configs:
        detector = runtime.get_mediapipe_detector(**config)
        result = detector.process(rgb_frame)
        for detection in result.detections or []:
            relative_box = detection.location_data.relative_bounding_box
            confidence = float(detection.score[0]) if detection.score else 0.0

            boxes.append(_DetectedBox(
                x=roi_offset_x + max(0, round(relative_box.xmin * scaled_w / scale)),
                y=roi_offset_y + max(0, round(relative_box.ymin * scaled_h / scale)),
                width=max(1, round(relative_box.width * scaled_w / scale)),
                height=max(1, round(relative_box.height * scaled_h / scale)),
                confidence=confidence,
                frame_time_ms=frame_time_ms,
                source_region=source_region,
            ))

        if boxes:
            break

    return boxes


def _detect_faces_in_roi(
    frame, roi_offset_x: int, roi_offset_y: int,
    roi_width: int, roi_height: int,
    runtime: _DetectorRuntime,
    frame_time_ms: int, source_region: str,
) -> tuple[list[_DetectedBox], str]:
    mp_boxes = _detect_faces_mediapipe(
        frame, roi_offset_x, roi_offset_y,
        roi_width, roi_height, runtime, frame_time_ms, source_region,
    )
    if mp_boxes:
        return mp_boxes, "mediapipe"

    return [], "none"


def _fallback_facecam_container(
    face_box: _DetectedBox, frame_width: int, frame_height: int,
) -> _DetectedBox:
    face_center_x = face_box.x + face_box.width / 2
    face_center_y = face_box.y + face_box.height / 2
    width = min(frame_width, round(face_box.width * 2.4))
    height = min(frame_height, round(face_box.height * 2.5))

    return _clamp_box(
        _DetectedBox(
            x=round(face_center_x - width / 2),
            y=round(face_center_y + face_box.height * 0.25 - height / 2),
            width=width, height=height,
            confidence=face_box.confidence * 0.92,
            frame_time_ms=face_box.frame_time_ms,
            source_region=face_box.source_region,
        ),
        frame_width, frame_height,
    )


def _candidate_from_anchor(
    face_box: _DetectedBox, frame_width: int, frame_height: int,
    aspect_ratio: float, face_width_fraction: float,
    face_center_x_fraction: float, face_center_y_fraction: float,
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
            width=width, height=height,
            confidence=face_box.confidence,
            frame_time_ms=face_box.frame_time_ms,
            source_region=face_box.source_region,
        ),
        frame_width, frame_height,
    )


def _is_plausible_container(
    box: _DetectedBox, face_box: _DetectedBox,
    frame_width: int, frame_height: int,
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


def _infer_facecam_container(
    face_box: _DetectedBox, frame_width: int, frame_height: int,
) -> _DetectedBox:
    fallback = _fallback_facecam_container(face_box, frame_width, frame_height)
    candidates: list[_DetectedBox] = [fallback]

    for aspect_ratio in (16 / 9, 4 / 3, 1.0, 3 / 4):
        for face_width_fraction in (0.32, 0.42, 0.52):
            for center_x_fraction in (0.45, 0.5, 0.55):
                for center_y_fraction in (0.38, 0.45, 0.52):
                    candidates.append(
                        _candidate_from_anchor(
                            face_box, frame_width, frame_height,
                            aspect_ratio, face_width_fraction,
                            center_x_fraction, center_y_fraction,
                        )
                    )

    plausible = [
        c for c in candidates
        if _is_plausible_container(c, face_box, frame_width, frame_height)
    ]

    if not plausible:
        return fallback

    def _size_score(box: _DetectedBox) -> float:
        face_area = face_box.width * face_box.height
        box_area = box.width * box.height
        ratio = box_area / max(face_area, 1)
        ideal_ratio = 5.0
        return 1.0 - min(abs(ratio - ideal_ratio) / ideal_ratio, 1.0)

    return max(plausible, key=_size_score)


def _sample_times(request: FacecamDetectionRequest, sampling_interval_ms: int) -> range:
    return range(request.startTimeMs, request.endTimeMs, sampling_interval_ms)


def _detect_boxes_for_stage(
    capture, request: FacecamDetectionRequest,
    frame_width: int, frame_height: int,
    stage_name: str, sampling_interval_ms: int,
    region_names: list[str], runtime: _DetectorRuntime,
    is_targeted_region: bool = False,
) -> _DetectionStageResult:
    import cv2

    regions = {
        name: region
        for name, region in _candidate_regions(frame_width, frame_height)
        if name in region_names
    }
    boxes: list[_DetectedBox] = []
    sampled_frame_count = 0
    detector_used = "none"

    for time_ms in _sample_times(request, sampling_interval_ms):
        capture.set(cv2.CAP_PROP_POS_MSEC, time_ms)
        ok, frame = capture.read()
        if not ok:
            continue

        sampled_frame_count += 1

        for region_name in region_names:
            region = regions.get(region_name)
            if region is None:
                continue

            left, top, right, bottom = region
            roi = frame[top:bottom, left:right]
            if roi.size == 0:
                continue

            roi_width = right - left
            roi_height = bottom - top

            face_boxes, det_name = _detect_faces_in_roi(
                roi, left, top, roi_width, roi_height,
                runtime, time_ms, region_name,
            )

            if face_boxes and det_name != "none":
                detector_used = det_name

            for face_box in face_boxes:
                adjusted_confidence = face_box.confidence

                if is_targeted_region:
                    adjusted_confidence = min(1.0, adjusted_confidence * REGION_PRIOR_BOOST)
                elif _is_in_center_region(face_box, frame_width, frame_height):
                    # Penalize faces in the center of a full-frame scan — likely game content
                    adjusted_confidence *= CENTER_FRAME_PENALTY

                face_box = _DetectedBox(
                    x=face_box.x, y=face_box.y,
                    width=face_box.width, height=face_box.height,
                    confidence=adjusted_confidence,
                    frame_time_ms=face_box.frame_time_ms,
                    source_region=face_box.source_region,
                )

                container = _infer_facecam_container(face_box, frame_width, frame_height)
                boxes.append(container)

    return _DetectionStageResult(
        stage_name=stage_name,
        sampling_interval_ms=sampling_interval_ms,
        sampled_frame_count=sampled_frame_count,
        boxes=boxes,
        detector_used=detector_used,
    )


def _describe_stage(stage: _DetectionStageResult) -> str:
    return (
        f"{stage.stage_name}@{stage.sampling_interval_ms}ms:"
        f"frames={stage.sampled_frame_count},boxes={len(stage.boxes)}"
        f",detector={stage.detector_used}"
    )


def _build_debug_summary(
    stage_results: list[_DetectionStageResult],
    total_frames: int,
    clusters: list[_BoxCluster],
    filtered_clusters: list[_BoxCluster],
) -> str:
    parts = [", ".join(_describe_stage(stage) for stage in stage_results)]
    total_boxes = sum(len(stage.boxes) for stage in stage_results)
    parts.append(f"total_boxes={total_boxes}")
    parts.append(f"total_frames={total_frames}")
    parts.append(f"clusters_before_filter={len(clusters)}")
    parts.append(f"clusters_after_filter={len(filtered_clusters)}")

    if filtered_clusters:
        top = filtered_clusters[0]
        parts.append(
            f"top_cluster: persistence={top.persistence_score(total_frames):.2f}"
            f", unique_frames={top.unique_frame_count}"
            f", avg_confidence={top.representative.confidence:.3f}"
        )

    return "; ".join(parts)


def detect_facecam_regions(
    request: FacecamDetectionRequest,
) -> FacecamDetectionResponse:
    try:
        import cv2
    except ImportError as error:
        raise RuntimeError("Media analysis dependencies are not installed.") from error

    runtime = _DetectorRuntime()
    video_path: str | None = None
    capture = None

    try:
        video_path = _download_to_temp_file(str(request.sourceDownloadUrl), request.sourceFilename)
        capture = cv2.VideoCapture(video_path)
        if not capture.isOpened():
            raise RuntimeError("Source video could not be opened for facecam detection.")

        frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))

        if frame_width <= 0 or frame_height <= 0:
            raise RuntimeError("Source video dimensions could not be read.")

        requested_interval = request.samplingIntervalMs
        dense_interval = 250 if requested_interval > 250 else None

        # Run corner/band regions FIRST (where facecams live)
        corner_stage = _detect_boxes_for_stage(
            capture, request, frame_width, frame_height,
            "corner_regions", requested_interval,
            [
                "bottom_center", "bottom_left", "bottom_right", "bottom_band",
                "top_left", "top_right", "top_band",
            ],
            runtime, is_targeted_region=True,
        )

        stage_results: list[_DetectionStageResult] = [corner_stage]

        # Only run full-frame if corner regions found very few detections
        if len(corner_stage.boxes) < 3:
            full_frame_stage = _detect_boxes_for_stage(
                capture, request, frame_width, frame_height,
                "full_frame", requested_interval, ["full_frame"],
                runtime, is_targeted_region=False,
            )
            stage_results.append(full_frame_stage)

        all_boxes = [box for stage in stage_results for box in stage.boxes]

        # Dense pass if still not enough detections
        if dense_interval is not None and len(all_boxes) < 3:
            dense_stage = _detect_boxes_for_stage(
                capture, request, frame_width, frame_height,
                "corner_regions_dense", dense_interval,
                [
                    "bottom_center", "bottom_left", "bottom_right", "bottom_band",
                    "top_left", "top_right", "top_band",
                ],
                runtime, is_targeted_region=True,
            )
            stage_results.append(dense_stage)
            all_boxes.extend(dense_stage.boxes)

        # Deduplicate: use max unique frame timestamps across all stages
        total_unique_times = len({
            box.frame_time_ms for box in all_boxes if box.frame_time_ms >= 0
        })
        total_frames = max(
            total_unique_times,
            max((stage.sampled_frame_count for stage in stage_results), default=0),
        )

        clusters = _cluster_boxes(all_boxes)
        filtered_clusters = _filter_clusters_by_persistence(clusters, total_frames)

        candidates: list[FacecamCandidate] = []
        for index, cluster in enumerate(filtered_clusters[: request.maxCandidateBoxes], start=1):
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

        detection_stage = (
            "+".join(stage.stage_name for stage in stage_results if stage.boxes)
            or None
        )

        return FacecamDetectionResponse(
            frameWidth=frame_width,
            frameHeight=frame_height,
            sampledFrameCount=sum(s.sampled_frame_count for s in stage_results),
            candidates=candidates,
            detectionStage=detection_stage,
            debugSummary=_build_debug_summary(
                stage_results, total_frames, clusters, filtered_clusters,
            ),
        )
    finally:
        if capture is not None:
            capture.release()
        runtime.close()
        if video_path is not None:
            Path(video_path).unlink(missing_ok=True)
