"""Filter construction for the Topaz /video/ create payload.

Astra (ast-*) requires `creativity` (0.0-1.0) inside its filter object per
https://developer.topazlabs.com/video-models/astra/astra-2. Starlight models
(slp-2.5, slhq-1, slm-1, slf-2, wonder-1) are plain enhancement filters.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.topaz_upscaler import _build_filters  # noqa: E402


def test_classic_model_only():
    assert _build_filters("ahq-12", None) == [{"model": "ahq-12"}]


def test_classic_model_with_interpolation():
    assert _build_filters("prob-4", "apo-8") == [
        {"model": "prob-4"},
        {"model": "apo-8"},
    ]


def test_starlight_models_are_plain_filters():
    for model in ("slp-2.5", "slhq-1", "slm-1", "slf-2", "wonder-1"):
        assert _build_filters(model, None) == [{"model": model}]


def test_astra_gets_default_creativity():
    assert _build_filters("ast-2", None) == [{"model": "ast-2", "creativity": 0.5}]


def test_astra_explicit_creativity():
    assert _build_filters("ast-2", None, creativity=0.8) == [
        {"model": "ast-2", "creativity": 0.8}
    ]


def test_astra_creativity_clamped_to_valid_range():
    assert _build_filters("ast-2", None, creativity=1.5)[0]["creativity"] == 1.0
    assert _build_filters("ast-2", None, creativity=-0.2)[0]["creativity"] == 0.0


def test_astra_creativity_accepts_string_payload_value():
    assert _build_filters("ast-2", None, creativity="0.7")[0]["creativity"] == 0.7


def test_astra_invalid_creativity_falls_back_to_default():
    assert _build_filters("ast-2", None, creativity="not-a-number")[0]["creativity"] == 0.5


def test_non_astra_model_ignores_creativity():
    assert _build_filters("slhq-1", None, creativity=0.9) == [{"model": "slhq-1"}]
    assert _build_filters("ahq-12", "apo-8", creativity=0.9) == [
        {"model": "ahq-12"},
        {"model": "apo-8"},
    ]


def test_astra_with_interpolation_keeps_both_filters():
    assert _build_filters("ast-2", "apo-8", creativity=0.3) == [
        {"model": "ast-2", "creativity": 0.3},
        {"model": "apo-8"},
    ]
