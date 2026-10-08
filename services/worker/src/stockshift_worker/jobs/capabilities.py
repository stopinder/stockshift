"""Default-off hosted CPU PDF policy; local verified workflows remain unchanged."""

import os
import time


def hosted_pdf_capabilities(env=None):
    env = os.environ if env is None else env

    def flag(name):
        value = env.get(f"STOCKSHIFT_HOSTED_PDF_{name}_ENABLED", "0")
        if value not in ("", "0", "1"):
            raise ValueError("Hosted PDF capability must be 0 or 1")
        return value == "1"

    inspection, extraction = flag("INSPECTION"), flag("EXTRACTION")
    if extraction and not inspection:
        raise ValueError("Digital extraction requires CPU inspection")
    if (inspection or extraction) and env.get("STOCKSHIFT_CSV_ONLY") == "1":
        raise ValueError("CSV-only mode conflicts with hosted PDF capabilities")
    if env.get("STOCKSHIFT_OCR_ENABLED", "0") not in ("", "0"):
        raise ValueError("Hosted CPU PDF capabilities require OCR disabled")
    return {"inspection": inspection, "extraction": extraction}


def hosted():
    return os.environ.get("STOCKSHIFT_SUPABASE_MODE") == "hosted"


def require_pdf_capability(operation):
    if hosted() and not hosted_pdf_capabilities()[operation]:
        raise ValueError(f"Hosted CPU PDF {operation} is disabled")


def require_pdf_worker_agreement(gateway):
    if not hosted():
        return
    caps = hosted_pdf_capabilities()
    if (
        gateway.rpc(
            "cpu_pdf_workers_agree",
            p_inspection=caps["inspection"],
            p_extraction=caps["extraction"],
        )
        is not True
    ):
        raise ValueError("Hosted CPU PDF worker capabilities disagree or expired")


def require_digital_configuration(configuration):
    if hosted() and (
        configuration.get("provider", "digital") != "digital"
        or configuration.get("layout_association")
    ):
        raise ValueError("Hosted CPU PDFs require direct digital extraction; OCR is disabled")


def advertise_pdf_worker(gateway, worker):
    if not hosted():
        return
    caps = hosted_pdf_capabilities()
    previous = getattr(gateway, "_cpu_pdf_advertised", None)
    now = time.monotonic()
    if previous and previous[0] == (worker, caps) and now - previous[1] < 30:
        return
    gateway.rpc(
        "register_cpu_pdf_worker",
        p_worker=worker,
        p_inspection=caps["inspection"],
        p_extraction=caps["extraction"],
    )
    gateway._cpu_pdf_advertised = ((worker, caps), now)
