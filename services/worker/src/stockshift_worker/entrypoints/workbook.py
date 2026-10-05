"""Local server adapter: private stdin bytes, safe JSON metadata, no network or credentials."""

import base64
import json
import sys

from stockshift_worker.domain.xlsx import WorkbookError, inspect_workbook


def main():
    try:
        request = json.loads(sys.stdin.buffer.read(15 * 1024 * 1024))
        data = base64.b64decode(request["data"], validate=True)
        output = inspect_workbook(data, request.get("worksheet"), request.get("headerRow", 1))
        print(json.dumps({"value": output}))
    except WorkbookError as exc:
        print(json.dumps({"error": str(exc)}))
    except Exception:
        print(
            json.dumps(
                {"error": "Cannot inspect this workbook. Save a fresh, unencrypted .xlsx copy."}
            )
        )


if __name__ == "__main__":
    main()
