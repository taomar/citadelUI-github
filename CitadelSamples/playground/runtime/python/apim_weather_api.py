#!/usr/bin/env python3
"""Upsert the sample `weather-api` and read back its operations.

This file is a SHIPPED wrapper, not generated source. The playground never
executes a Python string it composed: it runs this script with `shell=False`
and passes a JSON parameter object on stdin.

Parameters (stdin, JSON):
    action           "upsert" | "list-operations"
    subscriptionId   Azure subscription id
    resourceGroup    API Management resource group
    serviceName      API Management service name
    apiId            API id to create or inspect
    apiPath          gateway path            (upsert only)
    displayName      portal display name     (upsert only)
    keyHeader        custom subscription-key header name (upsert only)
    specPath         absolute path to the OpenAPI document (upsert only)
    policyPath       absolute path to the mock policy      (upsert only)

Result (stdout, last line, JSON):
    {"apiId": "..."} | {"operationNames": [...]} | {"error": "...", "type": "..."}

Authentication uses the Azure CLI credential you already have from `az login`.
No credential is read from, written to, or printed by this script.
"""

import json
import sys


def fail(message, kind="error"):
    print(json.dumps({"error": str(message), "type": kind}))
    sys.exit(1)


def main():
    try:
        params = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001 - the caller needs the reason
        fail(f"Could not read parameters: {exc}", "parameters")

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
        credential = AzureCliCredential()
        client = ApiManagementClient(credential, params["subscriptionId"])
    except Exception as exc:  # noqa: BLE001
        fail(f"Could not create the management client: {exc}", "authentication")

    rg = params["resourceGroup"]
    svc = params["serviceName"]
    api_id = params["apiId"]
    action = params.get("action")

    if action == "list-operations":
        try:
            names = [op.name for op in client.api_operation.list_by_api(rg, svc, api_id)]
        except Exception as exc:  # noqa: BLE001
            fail(f"Could not list operations for {api_id}: {exc}", "list-operations")
        print(json.dumps({"operationNames": names}))
        return

    if action != "upsert":
        fail(f"Unknown action {action!r}.", "parameters")

    from azure.mgmt.apimanagement.models import (
        ApiCreateOrUpdateParameter,
        PolicyContract,
        SubscriptionKeyParameterNamesContract,
    )

    try:
        with open(params["specPath"], "r", encoding="utf-8") as handle:
            spec = handle.read()
        with open(params["policyPath"], "r", encoding="utf-8") as handle:
            policy = handle.read()
    except OSError as exc:
        fail(f"Could not read the vendored API assets: {exc}", "assets")

    key_header = params["keyHeader"]
    try:
        client.api.begin_create_or_update(
            rg,
            svc,
            api_id,
            ApiCreateOrUpdateParameter(
                path=params["apiPath"],
                display_name=params["displayName"],
                description=(
                    "Weather API for getting dynamic weather information for a given location."
                ),
                format="openapi+json",
                value=spec,
                protocols=["https"],
                subscription_required=True,
                subscription_key_parameter_names=SubscriptionKeyParameterNamesContract(
                    header=key_header, query=key_header
                ),
                service_url="https://to-be-replaced-by-policy",
            ),
        ).result()
        client.api_policy.create_or_update(
            rg, svc, api_id, "policy", PolicyContract(value=policy, format="rawxml")
        )
    except Exception as exc:  # noqa: BLE001
        fail(f"Could not upsert {api_id}: {exc}", "upsert")

    print(json.dumps({"apiId": api_id}))


if __name__ == "__main__":
    main()
