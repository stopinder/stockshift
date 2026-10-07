"""At-least-once execution; fencing and atomic result publication live in PostgreSQL."""

import csv
from contextlib import contextmanager
from hashlib import sha256
from threading import Event, Thread
from uuid import UUID, uuid5

from stockshift_worker.domain.csv_engine import CsvOptions, parse_csv, reconcile
from stockshift_worker.domain.xlsx import MIME, WorkbookError, parse_xlsx
from stockshift_worker.extraction.digital_pdf import PdfError, normalize_pdf
from stockshift_worker.jobs.gateway import LeaseLost, TransportError, csv_only
from stockshift_worker.jobs.pdf import extract_job


class PreviewFormatError(ValueError):
    """Hosted preview permits only CSV, without invoking other extractors."""


def result_payload(run_id, old, new):
    """Keep normalized values, decimal text and field evidence without guessing matches."""
    old_records = {p["record_id"]: p for p in old.products}
    new_records = {p["record_id"]: p for p in new.products}
    evidence = {e["evidence_id"]: e for e in old.evidence + new.evidence}
    output = []
    for outcome in reconcile(old, new):
        a, b = old_records.get(outcome["old_record_id"]), new_records.get(outcome["new_record_id"])
        refs = [ref for product in (a, b) if product for ref in product["evidence_ids"]]
        zero = any(i["code"] == "zero_old_cost" for i in outcome["calculation_issues"])
        output.append(
            {
                "id": str(uuid5(UUID(run_id), outcome["result_id"])),
                "source_result_id": outcome["result_id"],
                "outcome": outcome["outcome"],
                "review_state": outcome["review_state"],
                "change_flags": outcome["change_flags"],
                "old_values": a,
                "new_values": b,
                "cost_delta": outcome["cost_delta"],
                "cost_change_percent": outcome["cost_change_percent"],
                "percentage_state": "zero_old_cost"
                if zero
                else (
                    "defined" if outcome["cost_change_percent"] is not None else "not_comparable"
                ),
                "reasons": outcome["calculation_issues"],
                "provenance": [evidence[ref] for ref in refs],
            }
        )
    if len(output) > 20000:
        raise ValueError("CSV result count exceeds 20000")
    return output


def verified_catalogue(gateway, file, tenant, options, revision=None):
    if (
        file["tenant_id"] != tenant
        or file["status"] != "ready"
        or file["verified_mime"] not in ("text/csv", MIME, "application/pdf")
        or not 1 <= file["byte_count"] <= 10485760
    ):
        raise ValueError("Ready same-tenant structured file required")
    data = gateway.download(file)
    if len(data) != file["byte_count"] or sha256(data).hexdigest() != file["sha256"]:
        raise ValueError("Registered file integrity verification failed")
    if file["verified_mime"] == "application/pdf":
        if (
            options.get("format") != "pdf"
            or not revision
            or revision.get("id") != options.get("revision_id")
            or revision.get("tenant_id") != tenant
        ):
            raise PdfError("Confirmed PDF revision outside source/tenant.")
        return normalize_pdf(
            revision, source_file_id=file["id"], source_name=file["original_filename"]
        )
    if file["verified_mime"] == MIME:
        return parse_xlsx(
            data, source_file_id=file["id"], source_name=file["original_filename"], options=options
        )
    settings_data = dict(options)
    if settings_data.pop("format", "csv") != "csv":
        raise ValueError("CSV settings required for CSV file")
    settings = CsvOptions(**settings_data)
    if settings.encoding not in ("utf-8", "utf-8-sig"):
        raise ValueError("Uploaded CSV must use UTF-8")
    return parse_csv(
        data, source_file_id=file["id"], source_name=file["original_filename"], options=settings
    )


@contextmanager
def heartbeat(gateway, lease, interval=30):
    stop, lost = Event(), Event()

    def renew():
        while not stop.wait(interval):
            try:
                gateway.rpc("heartbeat_csv_job", **lease)
            except Exception:
                # Fail closed: a network error also makes lease ownership uncertain.
                lost.set()
                return

    thread = Thread(target=renew, daemon=True)
    thread.start()
    try:
        yield lost
    finally:
        stop.set()
        thread.join(timeout=35)


def run_once(gateway, worker_id):
    job = gateway.rpc("claim_csv_job", p_worker=worker_id)
    if job is None:
        return False
    lease = {
        "p_tenant": job["tenant_id"],
        "p_job": job["id"],
        "p_worker": worker_id,
        "p_token": job["lease_token"],
    }
    stage = "load"
    try:
        with heartbeat(gateway, lease) as lost:
            if csv_only() and job.get("kind") == "extract_pdf":
                raise PreviewFormatError("This preview supports CSV only; PDF/OCR are unavailable.")
            if job.get("kind") == "extract_pdf":
                stage = "extract"
                extract_job(gateway, job, lease, lost)
                return True
            context = gateway.rpc("load_csv_job", **lease)
            run = context["run"]
            if run["tenant_id"] != job["tenant_id"] or run["id"] != job["comparison_run_id"]:
                raise ValueError("Run outside job tenant")
            if csv_only() and any(
                context[side]["verified_mime"] != "text/csv" for side in ("current", "incoming")
            ):
                raise PreviewFormatError(
                    "This preview supports CSV only; XLSX/PDF/OCR are unavailable."
                )
            stage = "parse"
            old = verified_catalogue(
                gateway,
                context["current"],
                job["tenant_id"],
                run["configuration"]["current"],
                context.get("current_revision"),
            )
            new = verified_catalogue(
                gateway,
                context["incoming"],
                job["tenant_id"],
                run["configuration"]["incoming"],
                context.get("incoming_revision"),
            )
            if (
                old.source_file_id != run["current_file_id"]
                or new.source_file_id != run["incoming_file_id"]
            ):
                raise ValueError("Input outside run")
            stage = "reconcile"
            results = result_payload(run["id"], old, new)
            if lost.is_set():
                raise LeaseLost("Heartbeat failed")
            gateway.rpc("heartbeat_csv_job", **lease)
            stage = "persist"
            gateway.rpc("complete_csv_job", **lease, p_results=results)
    except LeaseLost:
        # Reclaimed jobs belong to the replacement worker; never report failure against them.
        return True
    except Exception as exc:
        retryable = not isinstance(exc, (ValueError, TypeError, LookupError, csv.Error))
        failure = {
            "code": "preview_format_unavailable"
            if isinstance(exc, PreviewFormatError)
            else "pdf_timeout"
            if isinstance(exc, TimeoutError)
            else "invalid_pdf_job"
            if isinstance(exc, PdfError) or job.get("kind") == "extract_pdf" and not retryable
            else "transport_unavailable"
            if retryable
            else "invalid_xlsx_job"
            if isinstance(exc, WorkbookError)
            else "invalid_csv_job",
            "stage": stage,
            "message": str(exc)
            if isinstance(exc, (PdfError, TimeoutError, PreviewFormatError))
            else "Supabase transport unavailable"
            if retryable
            else str(exc)
            if isinstance(exc, WorkbookError)
            else "PDF settings or extraction validation failed. Export a supported PDF or CSV/XLSX."
            if job.get("kind") == "extract_pdf"
            else "CSV settings, input integrity or result validation failed",
            "retryable": retryable,
        }
        try:
            gateway.rpc("fail_csv_job", **lease, p_failure=failure, p_retryable=retryable)
        except (LeaseLost, TransportError):
            pass  # Durable lease expiry recovers a failure that could not be recorded.
    return True
