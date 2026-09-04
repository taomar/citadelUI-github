#!/usr/bin/env python3
"""Read an APIM subscription's primary key.

The documented fallback for the access contract: it runs ONLY when the
deployment outputs carried no `apiKey`. The value it returns is a credential —
the playground marks it as such, keeps it in memory for the requesting browser
tab, and never writes it to evidence, a log, or disk.

Parameters (stdin, JSON):
    subscriptionId, resourceGroup, serviceName, subscriptionName

Result (stdout, last line, JSON):
    {"apiKey": "..."} | {"error": "...", "type": "..."}
"""

import json
import sys


def fail(message, kind="error"):
    print(json.dumps({"error": str(message), "type": kind}))
    sys.exit(1)


def main():
    try:
        params = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        fail(f"Could not read parameters: {exc}", "parameters")

    if not params.get("subscriptionName"):
        fail("No APIM subscription name was resolved, so there is nothing to read.", "parameters")

    try:
        from azure.identity import AzureCliCredential
        from azure.mgmt.apimanagement import ApiManagementClient
    except ImportError as exc:
        fail(
            f"{exc}. Nothing is installed for you: run "
            "`python -m pip install -r runtime/requirements.txt`.",
            "missing-module",
        )

    try:
        client = ApiManagementClient(AzureCliCredential(), params["subscriptionId"])
        secrets = client.subscription.list_secrets(
            params["resourceGroup"], params["serviceName"], params["subscriptionName"]
        )
    except Exception as exc:  # noqa: BLE001
        fail(f"Could not read the subscription key: {exc}", "list-secrets")

    # Printed once, on the last line, and consumed by the executor as a secret.
    print(json.dumps({"apiKey": secrets.primary_key}))


if __name__ == "__main__":
    main()
