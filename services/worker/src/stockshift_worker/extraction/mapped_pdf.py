"""Explicit mapped OCR extraction in the ordinary durable PDF worker boundary."""

import json
from hashlib import sha256

from stockshift_worker.extraction.catalogue_layout import CatalogueLayoutExtractor, require
from stockshift_worker.extraction.paddleocr import PaddleClient, render_page


class MappedPdfExtractor:
    def __init__(self, data, configuration, *, cache=None, event=None, client=None):
        self.data, self.configuration = data, configuration
        self.cache, self.event, self.client = cache or {}, event or (lambda _: None), client
        self.raw_pages = []

    def extract(self, request, context):
        req, cfg = request.to_payload(), self.configuration
        plan = cfg["layout_association"]
        require(cfg.get("provider") == "auto", "Explicit OCR provider required for layout mapping.")
        png, width, height = render_page(self.data, plan["page"], cfg["dpi"])
        require(
            sha256(png).hexdigest() == plan["page_sha256"],
            "Rendered page differs; re-verify layout association.",
        )
        key = sha256(
            json.dumps(
                [req["tenant_id"], req["file_id"], req["sha256"], cfg, sha256(png).hexdigest()],
                sort_keys=True,
            ).encode()
        ).hexdigest()
        cached = self.cache.get(str(plan["page"]))
        count = (cached or {}).get("request_count", 0)
        cache_hit = bool(cached and cached["request_hash"] == key and cached["status"] == "ready")
        if cache_hit:
            raw = cached["response"]["layout_response"]
        else:
            self.event({"ocr_request": {"page": plan["page"], "request_hash": key}})
            raw = (self.client or PaddleClient(cfg["model_version"])).predict(png, key)
            count += 1
        mapper = CatalogueLayoutExtractor(raw, plan)
        result = mapper.extract(request, context)
        payload = result.to_payload()
        complete = payload["completion"]["state"] == "complete"
        if complete:
            if not cache_hit:
                self.event(
                    {
                        "ocr_page": {
                            "page": plan["page"],
                            "request_hash": key,
                            "response": {
                                "parsing_res_list": raw["result"]["layoutParsingResults"][0][
                                    "prunedResult"
                                ]["parsing_res_list"],
                                "layout_response": raw,
                            },
                        }
                    }
                )
        else:
            self.event(
                {
                    "ocr_failure": {
                        "page": plan["page"],
                        "request_hash": key,
                        "failure": {
                            "code": "ocr_layout",
                            "message": payload["warnings"][0]["message"],
                            "retryable": False,
                        },
                    }
                }
            )
        self.raw_pages = [
            {
                "page": plan["page"],
                "provider": "paddleocr-vl",
                "status": "completed" if complete else "failed",
                "confidence": None,
                "request_count": count,
                "rendered_sha256": sha256(png).hexdigest(),
                "rendered_width": width,
                "rendered_height": height,
                "request_hash": key,
                "layout": mapper.layout,
                "text": "\n".join(
                    " | ".join(c["value"] or "" for c in r["raw_cells"]) for r in payload["records"]
                ),
            }
        ]
        return result
