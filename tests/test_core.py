from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from cell_counter.imaging import (
    DEFAULT_PARAMETERS,
    analyze_channels,
    count_detections,
    segment_nuclei,
)
from cell_counter.project import scan_experiment


class ImagingTests(unittest.TestCase):
    def params(self, **changes):
        params = dict(DEFAULT_PARAMETERS)
        params.update(
            {
                "threshold_low": 30,
                "threshold_high": 255,
                "min_area_px": 40,
                "max_area_px": 5000,
                "watershed_min_distance": 8,
                "opening_radius": 0,
                "gaussian_sigma": 0.5,
            }
        )
        params.update(changes)
        return params

    def circle(self, array, x, y, radius, value):
        yy, xx = np.ogrid[: array.shape[0], : array.shape[1]]
        array[(xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2] = value

    def test_segments_two_nuclei(self):
        dapi = np.zeros((160, 180), dtype=np.uint8)
        self.circle(dapi, 45, 75, 12, 100)
        self.circle(dapi, 125, 75, 15, 110)
        labels = segment_nuclei(dapi, self.params())
        self.assertEqual(int(labels.max()), 2)

    def test_classifies_tumor_nk_double_and_unclassified(self):
        shape = (220, 240)
        dapi = np.zeros(shape, dtype=np.uint8)
        tumor = np.zeros(shape, dtype=np.uint8)
        nk = np.zeros(shape, dtype=np.uint8)
        positions = [(35, 55), (95, 55), (155, 55), (210, 55)]
        for x, y in positions:
            self.circle(dapi, x, y, 10, 100)
        self.circle(tumor, 35, 55, 16, 100)
        self.circle(nk, 95, 55, 16, 100)
        self.circle(tumor, 155, 55, 16, 100)
        self.circle(nk, 155, 55, 16, 100)
        params = self.params(
            perinuclear_radius_um=3,
            tumor_pixel_threshold=20,
            nk_pixel_threshold=20,
            tumor_positive_fraction=0.1,
            nk_positive_fraction=0.1,
        )
        detections = analyze_channels(dapi, nk, tumor, params, 1.0)
        classes = {item["classification"] for item in detections}
        self.assertEqual(
            classes, {"tumor", "nk", "double_positive", "unclassified"}
        )

    def test_count_manual_and_deleted(self):
        detections = [
            {"classification": "tumor", "manual": False, "deleted": False},
            {"classification": "nk", "manual": True, "deleted": False},
            {"classification": "nk", "manual": True, "deleted": True},
        ]
        counts = count_detections(detections)
        self.assertEqual(counts["dapi_total"], 2)
        self.assertEqual(counts["tumor"], 1)
        self.assertEqual(counts["nk"], 1)
        self.assertEqual(counts["corrected"], 2)


class ImportTests(unittest.TestCase):
    def test_pairs_generic_channel_suffixes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            group = root / "group-a"
            group.mkdir()
            array = np.zeros((40, 50, 3), dtype=np.uint8)
            for suffix in ("_blue", "_green", "_red"):
                Image.fromarray(array).save(group / f"field01{suffix}.png")
            project = scan_experiment(
                str(root),
                {"dapi": "_blue", "nk": "_green", "tumor": "_red"},
            )
            self.assertEqual(len(project["views"]), 1)
            self.assertEqual(project["views"][0]["group"], "group-a")
            self.assertEqual(project["views"][0]["status"], "pending")


if __name__ == "__main__":
    unittest.main()

