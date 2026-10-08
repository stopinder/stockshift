"""Test-only hosted HTTPS gateway with all requests rewritten to native loopback.

Production URL validation stays intact. This bridge never resolves the fake host.
"""

import os
from urllib.request import Request

from stockshift_worker.jobs.gateway import HostedGateway
from stockshift_worker.jobs.runner import run_once

origin = "https://cpu-fixture.supabase.co"
gateway = HostedGateway(origin, os.environ["STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY"])
real_opener = gateway.opener


class LoopbackOnly:
    def open(self, request, **kwargs):
        if not request.full_url.startswith(origin + "/"):
            raise AssertionError("Unexpected hosted origin")
        mapped = Request(
            "http://127.0.0.1:54321" + request.full_url[len(origin) :],
            data=request.data,
            headers=dict(request.header_items()),
            method=request.get_method(),
        )
        return real_opener.open(mapped, **kwargs)


gateway.opener = LoopbackOnly()
run_once(gateway, os.environ["STOCKSHIFT_TEST_WORKER_ID"])
