#!/usr/bin/env python3
"""Ask the published HR agent through the gateway with the Microsoft Agent Framework.

A shipped wrapper, not generated source. It reproduces cell 28: resolve the
agent card the gateway re-exposes, then run one turn with `A2AAgent`.

Parameters (stdin, JSON):
    agentUrl        gateway base URL for the published agent
    apiKeyHeader    header the contract key is presented in
    cardPath        relative agent-card path
    question        the question to ask
    timeoutSeconds  HTTP client timeout

The credential is read from the environment variable
CITADEL_GATEWAY_ACCESS_API_KEY, never from a parameter and never from a file.

Result (stdout, last line, JSON):
    {"answer": "...", "card": {...}} | {"error": "...", "type": "..."}
"""

import asyncio
import json
import os
import sys


def fail(message, kind="error"):
    print(json.dumps({"error": str(message), "type": kind}))
    sys.exit(1)


def main():
    try:
        params = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        fail(f"Could not read parameters: {exc}", "parameters")

    api_key = os.environ.get("CITADEL_GATEWAY_ACCESS_API_KEY", "")
    if not api_key:
        fail("No gateway key was supplied for this run.", "credential")

    if not params.get("agentUrl"):
        fail("No agent URL was resolved for this run.", "parameters")

    try:
        import httpx
        import nest_asyncio
        from a2a.client import A2ACardResolver
        from agent_framework.a2a import A2AAgent
    except ImportError as exc:
        fail(
            f"{exc}. Nothing is installed for you: run "
            "`python -m pip install -r runtime/requirements.txt`.",
            "missing-module",
        )

    nest_asyncio.apply()

    async def ask():
        headers = {params["apiKeyHeader"]: api_key}
        timeout = float(params.get("timeoutSeconds") or 120)
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as http_client:
            resolver = A2ACardResolver(httpx_client=http_client, base_url=params["agentUrl"])
            card = await resolver.get_agent_card(relative_card_path=params["cardPath"])
            agent = A2AAgent(
                name=card.name,
                description=card.description,
                agent_card=card,
                http_client=http_client,
            )
            response = await agent.run(params["question"])
            text = "\n".join(getattr(message, "text", "") or "" for message in response.messages)
            return text, card

    try:
        answer, card = asyncio.run(ask())
    except Exception as exc:  # noqa: BLE001
        fail(f"{type(exc).__name__}: {exc}", "agent-run")

    card_summary = {
        "name": getattr(card, "name", ""),
        "description": getattr(card, "description", ""),
        "url": getattr(card, "url", ""),
    }
    print(json.dumps({"answer": answer, "card": card_summary}))


if __name__ == "__main__":
    main()
