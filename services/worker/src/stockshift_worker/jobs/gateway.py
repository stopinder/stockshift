"""Local Supabase HTTP RPC/Storage client; no hosted URLs or standard credentials."""

import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class LeaseLost(RuntimeError):
    """An expired/replaced worker must never publish or change job state."""


class TransportError(RuntimeError):
    """Transient network or service failure, without response/credential logging."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Local API redirects are forbidden")


class LocalGateway:
    def __init__(self, url: str, key: str):
        parsed = urlparse(url)
        if (
            parsed.scheme != "http"
            or parsed.hostname not in ("127.0.0.1", "localhost")
            or parsed.port != 54321
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or not key
        ):
            raise ValueError("Only local Supabase on loopback port 54321 is supported")
        self.url, self.key = url.rstrip("/"), key
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    @classmethod
    def from_env(cls):
        return cls(
            os.environ.get("STOCKSHIFT_LOCAL_SUPABASE_URL", ""),
            os.environ.get("STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY", ""),
        )

    def request(self, path: str, payload=None, *, blob=False):
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, allow_nan=False).encode()
            if len(data) > 32 * 1024 * 1024:
                raise ValueError("Result payload exceeds safety limit")
        try:
            with self.opener.open(
                Request(self.url + path, data=data, headers=headers), timeout=30
            ) as r:
                # Bounded files/results; never read an unbounded HTTP response.
                content = r.read(32 * 1024 * 1024 + 1)
                if len(content) > 32 * 1024 * 1024:
                    raise ValueError("Local response exceeds safety limit")
                return content if blob else (json.loads(content) if content else None)
        except HTTPError as exc:
            if exc.code >= 500 or exc.code in (408, 429):
                raise TransportError("Local service unavailable") from None
            try:
                code = json.loads(exc.read(4096)).get("code")
            except (ValueError, AttributeError):
                code = None
            if code == "42501":
                raise LeaseLost("Worker authorization or lease rejected") from None
            raise ValueError("Local request rejected") from None
        except (URLError, TimeoutError, ConnectionError) as exc:
            raise TransportError("Local transport unavailable") from exc

    def rpc(self, name: str, **payload):
        if name not in {
            "claim_csv_job",
            "load_pdf_extraction",
            "pdf_extraction_progress",
            "complete_pdf_extraction",
            "heartbeat_csv_job",
            "load_csv_job",
            "complete_csv_job",
            "fail_csv_job",
        }:
            raise ValueError("Unknown worker operation")
        return self.request(f"/rest/v1/rpc/{name}", payload)

    def download(self, file):
        path = f"{file['tenant_id']}/{file['id']}/original"
        if file["bucket_id"] != "catalogue-uploads" or file["object_name"] != path:
            raise ValueError("Invalid registered object")
        return self.request(
            "/storage/v1/object/authenticated/catalogue-uploads/" + quote(path, safe="/"),
            blob=True,
        )
