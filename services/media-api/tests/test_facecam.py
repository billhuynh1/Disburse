from types import SimpleNamespace
import sys

import pytest

from app import facecam
from app.schemas import FacecamDetectionRequest


def box(time, confidence=0.35, width=240, height=180, x=0):
    return facecam._DetectedBox(x, 0, width, height, confidence, time, "top_left")


def test_sparse_cluster_is_rejected_only_in_v2():
    clusters = facecam._cluster_boxes([box(0)])
    assert facecam._filter_clusters_by_persistence(clusters, 10) == clusters
    accepted, reasons = facecam._accept_v2_clusters(clusters, 10, 1920, 1080)
    assert accepted == []
    assert "outcome=persistence" in reasons[0]


def test_overlapping_roi_detections_count_once_per_timestamp():
    boxes = facecam._deduplicate_boxes([box(0, 0.3), box(0, 0.4, x=2), box(500)])
    assert len(boxes) == 2
    assert boxes[0].confidence == 0.4
    assert facecam._cluster_boxes(boxes)[0].unique_frame_count == 2


@pytest.mark.parametrize("width,height,reason", [(1000, 600, "container_area"), (300, 700, "container_height")])
def test_oversized_containers_rejected(width, height, reason):
    clusters = facecam._cluster_boxes([box(0, width=width, height=height)])
    accepted, diagnostics = facecam._accept_v2_clusters(clusters, 1, 1920, 1080)
    assert accepted == []
    assert f"outcome={reason}" in diagnostics[0]


def test_inferred_fallback_is_subject_to_size_gate(monkeypatch):
    monkeypatch.setattr(facecam, "_is_plausible_container", lambda *args: False)
    container = facecam._infer_facecam_container(box(0, width=400, height=400), 1920, 1080)
    accepted, _ = facecam._accept_v2_clusters([facecam._BoxCluster([container])], 1, 1920, 1080)
    assert accepted == []


def test_small_facecam_keeps_low_confidence_and_existing_persistence_boundary():
    clusters = facecam._cluster_boxes([box(0, 0.30), box(500, 0.30)])
    accepted, reasons = facecam._accept_v2_clusters(clusters, 8, 1920, 1080)
    assert accepted == clusters
    assert "outcome=accepted" in reasons[0]
    assert facecam._accept_v2_clusters(clusters, 9, 1920, 1080)[0] == []


def test_short_window_still_enforces_persistence():
    assert facecam._accept_v2_clusters([facecam._BoxCluster([box(0)])], 2, 1920, 1080)[0]
    assert facecam._accept_v2_clusters([], 0, 1920, 1080)[0] == []


@pytest.mark.parametrize("version,expected_frames,expected_candidates", [
    ("facecam_v1", 17, 1), ("facecam_v2", 13, 0),
])
def test_orchestration_counts_empty_unique_frames_and_routes_versions(monkeypatch, version, expected_frames, expected_candidates):
    capture = SimpleNamespace(isOpened=lambda: True, get=lambda prop: 1920 if prop == 1 else 1080,
                              release=lambda: None)
    monkeypatch.setitem(sys.modules, "cv2", SimpleNamespace(VideoCapture=lambda _: capture,
                         CAP_PROP_FRAME_WIDTH=1, CAP_PROP_FRAME_HEIGHT=2))
    monkeypatch.setattr(facecam, "_download_to_temp_file", lambda *args: "/tmp/nonexistent-facecam-unit-test.mp4")
    stages = [
        facecam._DetectionStageResult("corner_regions", 500, 4, [box(0)], sampled_times={0, 500, 1000, 1500}),
        facecam._DetectionStageResult("full_frame", 500, 4, [], sampled_times={0, 500, 1500, 2500}),
        facecam._DetectionStageResult("corner_regions_dense", 250, 9, [box(0), box(0)], sampled_times={0, 250, 750, 1250, 1750, 2000, 2250}),
    ]
    # Failed reads do not contribute; successful empty frames always do.
    stages[2].sampled_times.update({2750, 3000})
    monkeypatch.setattr(facecam, "_detect_boxes_for_stage", lambda *args, **kwargs: stages.pop(0))
    request = FacecamDetectionRequest(sourceDownloadUrl="https://example.com/source.mp4",
                                     sourceFilename="source.mp4", startTimeMs=0, endTimeMs=3500,
                                     samplingIntervalMs=500, detectorVersion=version)
    result = facecam.detect_facecam_regions(request)
    assert result.sampledFrameCount == expected_frames
    assert len(result.candidates) == expected_candidates
    if version == "facecam_v2":
        assert "outcome=persistence" in result.debugSummary


def test_request_version_defaults_to_v1_and_rejects_unknown():
    payload = dict(sourceDownloadUrl="https://example.com/source.mp4", sourceFilename="source.mp4",
                   startTimeMs=0, endTimeMs=1000)
    assert FacecamDetectionRequest(**payload).detectorVersion == "facecam_v1"
    with pytest.raises(ValueError):
        FacecamDetectionRequest(**payload, detectorVersion="unknown")


def test_stage_tracks_successful_empty_frames_and_excludes_failed_reads(monkeypatch):
    roi = SimpleNamespace(size=1)

    class Frame:
        def __getitem__(self, _key):
            return roi

    frames = iter([(True, Frame()), (False, None), (True, Frame())])
    capture = SimpleNamespace(set=lambda *args: None, read=lambda: next(frames))
    monkeypatch.setitem(sys.modules, "cv2", SimpleNamespace(CAP_PROP_POS_MSEC=1))
    monkeypatch.setattr(facecam, "_detect_faces_in_roi", lambda *args: ([], "none"))
    request = FacecamDetectionRequest(sourceDownloadUrl="https://example.com/source.mp4",
                                     sourceFilename="source.mp4", startTimeMs=0, endTimeMs=1500)
    stage = facecam._detect_boxes_for_stage(capture, request, 1920, 1080, "full_frame", 500,
                                           ["full_frame"], facecam._DetectorRuntime())
    assert stage.sampled_times == {0, 1000}
    assert stage.sampled_frame_count == 2
    assert stage.boxes == []


@pytest.mark.parametrize("seen,total,width,height", [
    (9, 95, 688, 917), (18, 91, 547, 730), (15, 93, 892, 987),
    (16, 91, 704, 835), (26, 93, 772, 870), (32, 93, 780, 906),
    (16, 92, 400, 533),
])
def test_reported_candidate_metrics_are_rejected(seen, total, width, height):
    # Persisted diagnostics from the reported run, not a replay of the source.
    cluster = facecam._BoxCluster([box(time, width=width, height=height) for time in range(seen)])
    assert facecam._accept_v2_clusters([cluster], total, 1920, 1080)[0] == []


def test_oversized_outlier_does_not_erase_small_persistent_facecam():
    boxes = [box(time, width=450, height=500) for time in range(8)]
    boxes.append(box(8, 0.9, width=450, height=700))
    valid, diagnostics = facecam._filter_v2_boxes(boxes, 1920, 1080)
    clusters = facecam._cluster_boxes(facecam._deduplicate_boxes(valid))
    assert facecam._accept_v2_clusters(clusters, 9, 1920, 1080)[0]
    assert diagnostics == ["rejected_observations:container_height=1"]
    assert clusters[0].unique_frame_count == 8
