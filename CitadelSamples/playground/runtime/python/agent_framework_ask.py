#!/usr/bin/env python3
"""Ask the published HR agent through the gateway with the Microsoft Agent Framework.

A shipped wrapper, not generated source. It safely adapts cell 28: fetch and
validate the agent card the gateway re-exposes, then run one turn with
`A2AAgent` through a credential-injecting transport pinned to that gateway.

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
import copy
import json
import os
import re
import sys
from dataclasses import dataclass
from urllib.parse import urlsplit


CARD_PATH = "/.well-known/agent.json"
RAW_URL_HAZARD = re.compile(r"[\x00-\x20\x7f\\]")
HEADER_NAME = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")


class GatewayUrlError(ValueError):
    """The gateway or a card-advertised request target is not safe."""


@dataclass(frozen=True)
class GatewayTarget:
    scheme: str
    host: str
    port: int
    origin: str
    agent_path: str
    agent_url: str
    card_url: str


def fail(message, kind="error"):
    print(json.dumps({"error": str(message), "type": kind}))
    sys.exit(1)


def parse_https_url(raw_url, label):
    if not isinstance(raw_url, str) or not raw_url:
        raise GatewayUrlError(f"{label} must be a non-empty absolute URL.")
    if not raw_url.isascii() or RAW_URL_HAZARD.search(raw_url):
        raise GatewayUrlError(f"{label} contains an unsafe character.")
    if "%" in raw_url:
        raise GatewayUrlError(f"{label} must not contain percent-encoded components.")

    try:
        parsed = urlsplit(raw_url)
        port = parsed.port or 443
    except ValueError as exc:
        raise GatewayUrlError(f"{label} is not a valid absolute URL.") from exc

    if parsed.scheme.lower() != "https":
        raise GatewayUrlError(f"{label} must use https.")
    if parsed.username is not None or parsed.password is not None:
        raise GatewayUrlError(f"{label} must not contain user information.")
    if parsed.query or parsed.fragment:
        raise GatewayUrlError(f"{label} must not contain a query or fragment.")

    host = (parsed.hostname or "").lower()
    if not host or host.endswith("."):
        raise GatewayUrlError(f"{label} must contain an unambiguous host.")

    path = parsed.path
    if not path.startswith("/") or path == "/" or path.endswith("/") or "//" in path:
        raise GatewayUrlError(f"{label} must contain one canonical agent path.")
    if any(segment in (".", "..") for segment in path.split("/")):
        raise GatewayUrlError(f"{label} must not contain dot segments.")

    return parsed, host, port


def gateway_target(agent_url, card_path):
    if card_path != CARD_PATH:
        raise GatewayUrlError("The agent-card path is not the registered gateway path.")

    parsed, host, port = parse_https_url(agent_url, "The agent URL")
    authority_host = f"[{host}]" if ":" in host else host
    authority = authority_host if port == 443 else f"{authority_host}:{port}"
    origin = f"https://{authority}"
    canonical_agent_url = f"{origin}{parsed.path}"
    return GatewayTarget(
        scheme="https",
        host=host,
        port=port,
        origin=origin,
        agent_path=parsed.path,
        agent_url=canonical_agent_url,
        card_url=f"{canonical_agent_url}{CARD_PATH}",
    )


def validate_request_url(raw_url, target, method):
    parsed, host, port = parse_https_url(raw_url, "An outgoing A2A request URL")
    if (parsed.scheme.lower(), host, port) != (target.scheme, target.host, target.port):
        raise GatewayUrlError("An outgoing A2A request targeted an unapproved origin.")

    method = str(method).upper()
    if method == "GET" and parsed.path == f"{target.agent_path}{CARD_PATH}":
        return
    if method == "POST" and parsed.path == target.agent_path:
        return
    raise GatewayUrlError("An outgoing A2A request targeted an unapproved gateway path.")


def card_transport_entries(card_data):
    entries = []

    def add_entry(label, value, binding):
        if not isinstance(value, str) or not value:
            raise GatewayUrlError(f"The agent card has no URL for {label}.")
        if not isinstance(binding, str) or binding.upper() != "JSONRPC":
            raise GatewayUrlError(f"The agent card advertises an unsupported transport for {label}.")
        entries.append((label, value))

    if "url" in card_data:
        add_entry("url", card_data.get("url"), card_data.get("preferredTransport", "JSONRPC"))

    for field_name in ("supportedInterfaces", "supported_interfaces"):
        if field_name not in card_data:
            continue
        interfaces = card_data[field_name]
        if not isinstance(interfaces, list):
            raise GatewayUrlError(f"The agent card field {field_name} must be an array.")
        for index, interface in enumerate(interfaces):
            if not isinstance(interface, dict):
                raise GatewayUrlError(f"The agent card field {field_name}[{index}] must be an object.")
            add_entry(
                f"{field_name}[{index}]",
                interface.get("url"),
                interface.get("protocolBinding", interface.get("protocol_binding", interface.get("transport"))),
            )

    for field_name in ("additionalInterfaces", "additional_interfaces"):
        if field_name not in card_data:
            continue
        interfaces = card_data[field_name]
        if not isinstance(interfaces, list):
            raise GatewayUrlError(f"The agent card field {field_name} must be an array.")
        for index, interface in enumerate(interfaces):
            if not isinstance(interface, dict):
                raise GatewayUrlError(f"The agent card field {field_name}[{index}] must be an object.")
            add_entry(
                f"{field_name}[{index}]",
                interface.get("url"),
                interface.get("transport", interface.get("protocolBinding", interface.get("protocol_binding"))),
            )

    if not entries:
        raise GatewayUrlError("The agent card advertises no A2A transport URL.")
    return entries


def validate_agent_card_routes(card_data, target):
    if not isinstance(card_data, dict):
        raise GatewayUrlError("The agent card must be a JSON object.")
    urls = []
    for _label, raw_url in card_transport_entries(card_data):
        parsed, host, port = parse_https_url(raw_url, "An agent-card transport URL")
        if (parsed.scheme.lower(), host, port) != (target.scheme, target.host, target.port):
            raise GatewayUrlError("The agent card advertises an unapproved transport origin.")
        if parsed.path != target.agent_path:
            raise GatewayUrlError("The agent card advertises an unapproved transport path.")
        urls.append(raw_url)
    return list(dict.fromkeys(urls))


def parse_agent_card(card_data):
    try:
        from a2a.client.card_resolver import parse_agent_card as sdk_parse_agent_card
    except ImportError:
        from a2a.types import AgentCard

        return AgentCard.model_validate(card_data)
    return sdk_parse_agent_card(card_data)


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
        from agent_framework.a2a import A2AAgent
    except ImportError as exc:
        fail(
            f"{exc}. Nothing is installed for you: run "
            "`python -m pip install -r runtime/requirements.txt`.",
            "missing-module",
        )

    nest_asyncio.apply()

    async def ask():
        target = gateway_target(params["agentUrl"], params.get("cardPath"))
        api_key_header = params.get("apiKeyHeader")
        if not isinstance(api_key_header, str) or not HEADER_NAME.fullmatch(api_key_header):
            raise ValueError("The gateway key header name is invalid.")
        timeout = float(params.get("timeoutSeconds") or 120)

        class GatewayCredentialTransport(httpx.AsyncBaseTransport):
            def __init__(self):
                self._transport = httpx.AsyncHTTPTransport(retries=0, trust_env=False)

            async def handle_async_request(self, request):
                validate_request_url(str(request.url), target, request.method)
                request.headers[api_key_header] = api_key
                response = await self._transport.handle_async_request(request)
                if 300 <= response.status_code < 400:
                    await response.aclose()
                    raise GatewayUrlError("Gateway redirects are not allowed.")
                return response

            async def aclose(self):
                await self._transport.aclose()

        async with httpx.AsyncClient(
            timeout=timeout,
            transport=GatewayCredentialTransport(),
            follow_redirects=False,
            trust_env=False,
        ) as http_client:
            card_response = await http_client.get(target.card_url, headers={"Accept": "application/json"})
            card_response.raise_for_status()
            card_data = card_response.json()
            transport_urls = validate_agent_card_routes(card_data, target)
            card = parse_agent_card(copy.deepcopy(card_data))
            agent = A2AAgent(
                name=card.name,
                description=card.description,
                agent_card=card,
                http_client=http_client,
            )
            response = await agent.run(params["question"])
            text = "\n".join(getattr(message, "text", "") or "" for message in response.messages)
            card_summary = {
                "name": getattr(card, "name", ""),
                "description": getattr(card, "description", ""),
                "url": transport_urls[0],
                "transportUrls": transport_urls,
            }
            route = {
                "validated": True,
                "expectedOrigin": target.origin,
                "expectedAgentPath": target.agent_path,
            }
            return text, card_summary, route

    try:
        answer, card_summary, route = asyncio.run(ask())
    except Exception as exc:  # noqa: BLE001
        message = f"{type(exc).__name__}: {exc}".replace(api_key, "[redacted]")
        fail(message, "agent-run")

    print(json.dumps({"answer": answer, "card": card_summary, "route": route}))


if __name__ == "__main__":
    main()
