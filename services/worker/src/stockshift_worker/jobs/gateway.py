"""Explicit local/hosted Supabase RPC and private Storage; no credential fallback."""

import base64
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class LeaseLost(RuntimeError):
    """An expired/replaced worker must never publish or change job state."""


class TransportError(RuntimeError):
    """Transient network or service failure, without response/credential logging."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Supabase API redirects are forbidden")


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
        headers = {"apikey": self.key}
        # Opaque secret keys are not JWTs. Legacy service_role keys require Bearer.
        if not self.key.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {self.key}"
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
                    raise ValueError("Supabase response exceeds safety limit")
                return content if blob else (json.loads(content) if content else None)
        except HTTPError as exc:
            if exc.code >= 500 or exc.code in (408, 429):
                raise TransportError("Supabase service unavailable") from None
            try:
                code = json.loads(exc.read(4096)).get("code")
            except (ValueError, AttributeError):
                code = None
            if code == "42501":
                raise LeaseLost("Worker authorization or lease rejected") from None
            raise ValueError("Supabase request rejected") from None
        except (URLError, TimeoutError, ConnectionError) as exc:
            raise TransportError("Supabase transport unavailable") from exc

    def rpc(self, name: str, **payload):
        if name not in {
            "claim_csv_job",
            "register_cpu_pdf_worker",
            "cpu_pdf_workers_agree",
            "load_pdf_inspection",
            "complete_pdf_inspection",
            "load_pdf_extraction",
            "pdf_extraction_progress",
            "complete_pdf_extraction",
            "record_ocr_page",
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


class HostedGateway(LocalGateway):
    """HTTPS hosted project, explicitly selected; never reads local credentials."""

    def __init__(self, url: str, key: str):
        parsed = urlparse(url)
        if (
            parsed.scheme != "https"
            or not re.fullmatch(r"[a-z0-9-]+\.supabase\.co", parsed.hostname or "")
            or parsed.port not in (None, 443)
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Hosted Supabase requires a project HTTPS origin")
        valid = bool(re.fullmatch(r"sb_secret_[A-Za-z0-9_-]+", key))
        if not valid:
            try:
                parts = key.split(".")
                claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
                valid = len(parts) == 3 and claims.get("role") == "service_role"
            except (ValueError, IndexError, AttributeError):
                valid = False
        if not valid:
            raise ValueError("Hosted worker requires a server-only secret/service_role key")
        self.url, self.key = url.rstrip("/"), key
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    @classmethod
    def from_env(cls):
        return cls(
            os.environ.get("STOCKSHIFT_SUPABASE_URL", ""),
            os.environ.get("STOCKSHIFT_SUPABASE_SECRET_KEY", ""),
        )

    def rpc(self, name: str, **payload):
        if name == "record_ocr_page":
            raise ValueError("Hosted CPU worker cannot request or record OCR")
        return super().rpc(name, **payload)


def gateway_from_env():
    mode = os.environ.get("STOCKSHIFT_SUPABASE_MODE", "local")
    if mode == "hosted":
        from stockshift_worker.jobs.capabilities import hosted_pdf_capabilities

        hosted_pdf_capabilities()
        return HostedGateway.from_env()
    if mode != "local":
        raise ValueError("Choose local or hosted Supabase mode")
    return LocalGateway.from_env()


def csv_only():
    from stockshift_worker.jobs.capabilities import hosted_pdf_capabilities

    return (
        os.environ.get("STOCKSHIFT_SUPABASE_MODE") == "hosted"
        and not hosted_pdf_capabilities()["inspection"]
    ) or os.environ.get("STOCKSHIFT_CSV_ONLY") == "1"
