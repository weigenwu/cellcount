from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi
from skimage import feature, filters, measure, morphology, segmentation


SUPPORTED_EXTENSIONS = {".tif", ".tiff", ".png", ".jpg", ".jpeg"}
CHANNEL_COMPONENT = {"dapi": 2, "nk": 1, "tumor": 0}
CLASS_COLORS = {
    "tumor": (255, 74, 91),
    "nk": (65, 224, 144),
    "double_positive": (255, 190, 72),
    "unclassified": (71, 189, 255),
}


DEFAULT_PARAMETERS: dict[str, Any] = {
    "threshold_mode": "manual",
    "threshold_low": 20,
    "threshold_high": 129,
    "gaussian_sigma": 1.0,
    "opening_radius": 1,
    "watershed_min_distance": 12,
    "min_area_px": 400,
    "max_area_px": 20000,
    "min_circularity": 0.03,
    "max_circularity": 1.0,
    "perinuclear_radius_um": 5.0,
    "tumor_pixel_threshold": 20.0,
    "tumor_positive_fraction": 0.15,
    "nk_pixel_threshold": 20.0,
    "nk_positive_fraction": 0.10,
}


def _open_single_frame(path: str | Path) -> Image.Image:
    image = Image.open(path)
    if getattr(image, "n_frames", 1) != 1:
        image.close()
        raise ValueError(f"暂不支持多页图像：{Path(path).name}")
    return image


def image_size(path: str | Path) -> tuple[int, int]:
    with _open_single_frame(path) as image:
        return image.size


def read_signal(path: str | Path, channel: str) -> np.ndarray:
    with _open_single_frame(path) as image:
        array = np.asarray(image)
    if array.ndim == 2:
        return array.astype(np.float32, copy=False)
    if array.ndim == 3:
        if array.shape[2] < 3:
            return array[..., 0].astype(np.float32, copy=False)
        return array[..., CHANNEL_COMPONENT[channel]].astype(np.float32, copy=False)
    raise ValueError(f"无法识别的图像维度：{array.shape}")


def _validate_parameters(params: dict[str, Any]) -> dict[str, Any]:
    result = {**DEFAULT_PARAMETERS, **params}
    result["threshold_low"] = max(0, min(255, int(result["threshold_low"])))
    result["threshold_high"] = max(0, min(255, int(result["threshold_high"])))
    if result["threshold_low"] > result["threshold_high"]:
        raise ValueError("DAPI 阈值下限不能大于上限")
    result["min_area_px"] = max(1, int(result["min_area_px"]))
    result["max_area_px"] = max(result["min_area_px"], int(result["max_area_px"]))
    result["min_circularity"] = max(0.0, float(result["min_circularity"]))
    result["max_circularity"] = min(1.0, float(result["max_circularity"]))
    result["gaussian_sigma"] = max(0.0, float(result["gaussian_sigma"]))
    result["opening_radius"] = max(0, int(result["opening_radius"]))
    result["watershed_min_distance"] = max(1, int(result["watershed_min_distance"]))
    result["perinuclear_radius_um"] = max(0.0, float(result["perinuclear_radius_um"]))
    for key in ("tumor_positive_fraction", "nk_positive_fraction"):
        result[key] = max(0.0, min(1.0, float(result[key])))
    return result


def segment_nuclei(dapi: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    params = _validate_parameters(params)
    smoothed = filters.gaussian(
        dapi,
        sigma=params["gaussian_sigma"],
        preserve_range=True,
    )
    if params["threshold_mode"] == "auto":
        nonzero = smoothed[smoothed > 0]
        threshold = filters.threshold_otsu(nonzero) if nonzero.size else 255
        mask = smoothed >= threshold
    else:
        mask = (smoothed >= params["threshold_low"]) & (
            smoothed <= params["threshold_high"]
        )

    if params["opening_radius"]:
        mask = morphology.binary_opening(
            mask, morphology.disk(params["opening_radius"])
        )
    mask = morphology.remove_small_objects(
        mask, min_size=max(4, params["min_area_px"] // 4)
    )
    if not np.any(mask):
        return np.zeros(mask.shape, dtype=np.int32)

    distance = ndi.distance_transform_edt(mask)
    coordinates = feature.peak_local_max(
        distance,
        min_distance=params["watershed_min_distance"],
        labels=mask,
        exclude_border=False,
    )
    markers = np.zeros(mask.shape, dtype=np.int32)
    if coordinates.size:
        markers[tuple(coordinates.T)] = np.arange(1, len(coordinates) + 1)
        markers, _ = ndi.label(markers > 0)
        labels = segmentation.watershed(-distance, markers, mask=mask)
    else:
        labels, _ = ndi.label(mask)

    filtered = np.zeros(labels.shape, dtype=np.int32)
    output_label = 1
    for region in measure.regionprops(labels):
        area = float(region.area)
        perimeter = float(region.perimeter)
        circularity = 4 * math.pi * area / (perimeter * perimeter) if perimeter else 1
        if (
            params["min_area_px"] <= area <= params["max_area_px"]
            and params["min_circularity"]
            <= circularity
            <= params["max_circularity"]
        ):
            filtered[labels == region.label] = output_label
            output_label += 1
    return filtered


def _positive_fraction(
    signal: np.ndarray,
    center_x: float,
    center_y: float,
    inner_radius: float,
    background_gap: float,
    pixel_threshold: float,
) -> tuple[float, float]:
    yy, xx = np.ogrid[: signal.shape[0], : signal.shape[1]]
    distance_squared = (xx - center_x) ** 2 + (yy - center_y) ** 2
    inner = distance_squared <= inner_radius**2
    background_start = inner_radius + max(2.0, background_gap)
    background_end = background_start + max(4.0, background_gap)
    annulus = (distance_squared >= background_start**2) & (
        distance_squared <= background_end**2
    )
    background = float(np.median(signal[annulus])) if np.any(annulus) else 0.0
    corrected = signal[inner] - background
    fraction = float(np.mean(corrected >= pixel_threshold)) if corrected.size else 0
    return fraction, background


def analyze_channels(
    dapi: np.ndarray,
    nk: np.ndarray,
    tumor: np.ndarray,
    params: dict[str, Any],
    pixel_size_um: float,
) -> list[dict[str, Any]]:
    params = _validate_parameters(params)
    if dapi.shape != nk.shape or dapi.shape != tumor.shape:
        raise ValueError("三通道图像尺寸不一致")
    labels = segment_nuclei(dapi, params)
    radius_px = max(
        1, round(params["perinuclear_radius_um"] / max(pixel_size_um, 1e-6))
    )
    detections: list[dict[str, Any]] = []
    for index, region in enumerate(measure.regionprops(labels), start=1):
        min_row, min_col, max_row, max_col = region.bbox
        area = float(region.area)
        equivalent_radius = math.sqrt(area / math.pi)
        inner_radius = equivalent_radius + radius_px
        margin = max(math.ceil(inner_radius + radius_px * 2 + 2), 6)
        r0, c0 = max(0, min_row - margin), max(0, min_col - margin)
        r1 = min(labels.shape[0], max_row + margin)
        c1 = min(labels.shape[1], max_col + margin)
        y, x = region.centroid
        local_x, local_y = x - c0, y - r0
        tumor_fraction, tumor_background = _positive_fraction(
            tumor[r0:r1, c0:c1],
            local_x,
            local_y,
            inner_radius,
            radius_px,
            params["tumor_pixel_threshold"],
        )
        nk_fraction, nk_background = _positive_fraction(
            nk[r0:r1, c0:c1],
            local_x,
            local_y,
            inner_radius,
            radius_px,
            params["nk_pixel_threshold"],
        )
        tumor_positive = tumor_fraction >= params["tumor_positive_fraction"]
        nk_positive = nk_fraction >= params["nk_positive_fraction"]
        if tumor_positive and nk_positive:
            classification = "double_positive"
        elif tumor_positive:
            classification = "tumor"
        elif nk_positive:
            classification = "nk"
        else:
            classification = "unclassified"
        perimeter = float(region.perimeter)
        detections.append(
            {
                "id": f"auto-{index}",
                "x": round(float(x), 2),
                "y": round(float(y), 2),
                "area_px": round(area, 2),
                "area_um2": round(area * pixel_size_um * pixel_size_um, 3),
                "radius": round(math.sqrt(area / math.pi), 2),
                "circularity": round(
                    4 * math.pi * area / (perimeter * perimeter)
                    if perimeter
                    else 1.0,
                    4,
                ),
                "classification": classification,
                "tumor_fraction": round(tumor_fraction, 4),
                "nk_fraction": round(nk_fraction, 4),
                "tumor_background": round(tumor_background, 3),
                "nk_background": round(nk_background, 3),
                "manual": False,
                "deleted": False,
            }
        )
    return detections


def make_preview(
    path: str | Path,
    max_width: int = 1600,
    max_height: int = 1100,
    quality: int = 88,
) -> tuple[bytes, tuple[int, int]]:
    from io import BytesIO

    with _open_single_frame(path) as image:
        image = image.convert("RGB")
        original_size = image.size
        image.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
        output = BytesIO()
        image.save(output, "JPEG", quality=quality, optimize=True)
    return output.getvalue(), original_size


def export_annotated(
    source_path: str | Path,
    detections: list[dict[str, Any]],
    output_path: str | Path,
) -> None:
    with _open_single_frame(source_path) as image:
        canvas = image.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=16)
    for index, detection in enumerate(detections, start=1):
        if detection.get("deleted"):
            continue
        color = CLASS_COLORS.get(detection["classification"], (255, 255, 255))
        x, y = float(detection["x"]), float(detection["y"])
        radius = max(8.0, float(detection.get("radius", 12)))
        draw.ellipse(
            (x - radius, y - radius, x + radius, y + radius),
            outline=color,
            width=3,
        )
        draw.text((x + radius + 2, y - radius), str(index), fill=color, font=font)
    canvas.save(output_path, "PNG", optimize=True)


def count_detections(detections: list[dict[str, Any]]) -> dict[str, int]:
    active = [item for item in detections if not item.get("deleted")]
    counts = {
        "dapi_total": len(active),
        "tumor": 0,
        "nk": 0,
        "unclassified": 0,
        "double_positive": 0,
        "corrected": sum(
            1 for item in detections if item.get("manual") or item.get("deleted")
        ),
    }
    for item in active:
        key = item.get("classification", "unclassified")
        if key in counts:
            counts[key] += 1
    return counts
