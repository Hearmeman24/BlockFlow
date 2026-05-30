from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store  # noqa: E402


def _load_sidecar(slug: str):
    path = ROOT / "custom_blocks" / slug / "backend.block.py"
    spec = importlib.util.spec_from_file_location(f"{slug}_backend_for_asset_upload_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def fresh_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "DB_PATH", tmp_path / "settings.db")
    settings_store.init_db()


def test_asset_upload_mode_defaults_to_tmpfiles():
    from backend import asset_uploads

    assert asset_uploads.get_asset_storage_mode() == "tmpfiles"


def test_asset_upload_mode_invalid_value_falls_back_to_tmpfiles():
    from backend import asset_uploads

    settings_store.set_app_pref("asset_storage_mode", "forever_public")

    assert asset_uploads.get_asset_storage_mode() == "tmpfiles"


def test_local_only_mode_refuses_remote_upload():
    from backend import asset_uploads

    settings_store.set_app_pref("asset_storage_mode", "local_only")

    with pytest.raises(asset_uploads.RemoteAssetUploadDisabled) as exc:
        asset_uploads.upload_asset(
            b"image-bytes",
            filename="source.png",
            content_type="image/png",
            media_kind="image",
        )

    assert "local-only" in str(exc.value).lower()


def test_tmpfiles_mode_uses_tmpfiles_boundary(monkeypatch):
    from backend import asset_uploads

    settings_store.set_app_pref("asset_storage_mode", "tmpfiles")
    calls: list[tuple[bytes, str, str]] = []

    def fake_upload(data: bytes, filename: str, content_type: str) -> str:
        calls.append((data, filename, content_type))
        return "https://tmpfiles.org/dl/abc/source.png"

    monkeypatch.setattr(asset_uploads, "_upload_to_tmpfiles", fake_upload)

    result = asset_uploads.upload_asset(
        b"image-bytes",
        filename="source.png",
        content_type="image/png",
        media_kind="image",
    )

    assert result == {
        "url": "https://tmpfiles.org/dl/abc/source.png",
        "provider": "tmpfiles",
        "expires_at": None,
    }
    assert calls == [(b"image-bytes", "source.png", "image/png")]


def test_r2_mode_requires_credentials():
    from backend import asset_uploads

    settings_store.set_app_pref("asset_storage_mode", "r2_signed")

    with pytest.raises(RuntimeError) as exc:
        asset_uploads.upload_asset(
            b"image-bytes",
            filename="source.png",
            content_type="image/png",
            media_kind="image",
        )

    assert "r2 credentials incomplete" in str(exc.value).lower()
    assert "r2_access_key_id" in str(exc.value)


def test_r2_mode_uploads_private_object_and_returns_presigned_url(monkeypatch):
    from backend import asset_uploads

    class FakeClient:
        def __init__(self):
            self.put_calls = []

        def put_object(self, **kwargs):
            self.put_calls.append(kwargs)

        def generate_presigned_url(self, operation, Params, ExpiresIn):
            assert operation == "get_object"
            assert Params["Bucket"] == "private-assets"
            assert Params["Key"].startswith("blockflow/assets/image/")
            assert ExpiresIn == asset_uploads.DEFAULT_PRESIGNED_TTL_SECONDS
            return "https://r2.example/presigned"

    fake_client = FakeClient()

    def fake_make_client(*, endpoint_url: str, access_key_id: str, secret_access_key: str):
        assert endpoint_url == "https://acct.r2.cloudflarestorage.com"
        assert access_key_id == "access"
        assert secret_access_key == "secret"
        return fake_client

    settings_store.set_app_pref("asset_storage_mode", "r2_signed")
    settings_store.set_credential("r2_endpoint_url", "https://acct.r2.cloudflarestorage.com")
    settings_store.set_credential("r2_access_key_id", "access")
    settings_store.set_credential("r2_secret_access_key", "secret")
    settings_store.set_credential("r2_bucket", "private-assets")
    monkeypatch.setattr(asset_uploads, "_make_r2_client", fake_make_client)

    result = asset_uploads.upload_asset(
        b"image-bytes",
        filename="../source.png",
        content_type="image/png",
        media_kind="image",
    )

    assert result["url"] == "https://r2.example/presigned"
    assert result["provider"] == "r2_signed"
    assert result["expires_at"]
    assert len(fake_client.put_calls) == 1
    put = fake_client.put_calls[0]
    assert put["Bucket"] == "private-assets"
    assert put["Body"] == b"image-bytes"
    assert put["ContentType"] == "image/png"
    assert Path(put["Key"]).name.endswith("-source.png")


def test_image_upload_route_returns_provider_metadata(monkeypatch):
    from backend import asset_uploads

    mod = _load_sidecar("upload_image_to_tmpfiles")
    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)

    def fake_upload(data: bytes, *, filename: str, content_type: str, media_kind: str):
        assert data == b"image-bytes"
        assert filename == "source.png"
        assert content_type == "image/png"
        assert media_kind == "image"
        return {
            "url": "https://r2.example/image.png",
            "provider": "r2_signed",
            "expires_at": "2026-05-30T12:00:00+00:00",
        }

    monkeypatch.setattr(asset_uploads, "upload_asset", fake_upload)

    res = client.post(
        "/upload",
        content=b"image-bytes",
        headers={"X-Filename": "source.png", "X-Content-Type": "image/png"},
    )

    assert res.status_code == 200
    assert res.json() == {
        "ok": True,
        "image_url": "https://r2.example/image.png",
        "provider": "r2_signed",
        "expires_at": "2026-05-30T12:00:00+00:00",
    }


def test_video_upload_route_reports_local_only_without_network(monkeypatch):
    from backend import asset_uploads

    mod = _load_sidecar("video_loader")
    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)

    def disabled(*args, **kwargs):
        raise asset_uploads.RemoteAssetUploadDisabled("Remote asset upload is disabled by local-only storage mode")

    monkeypatch.setattr(asset_uploads, "upload_asset", disabled)

    res = client.post(
        "/upload",
        content=b"video-bytes",
        headers={"X-Filename": "clip.mp4", "X-Content-Type": "video/mp4"},
    )

    assert res.status_code == 200
    assert res.json() == {
        "ok": False,
        "error": "Remote asset upload is disabled by local-only storage mode",
        "provider": "local_only",
    }
