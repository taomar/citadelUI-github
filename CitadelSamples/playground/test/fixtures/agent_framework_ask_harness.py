"""Dependency-free fake Agent Framework/httpx harness for the shipped wrapper."""

import json
import runpy
import sys
import types
from types import SimpleNamespace
from urllib.parse import urljoin


WRAPPER_PATH = sys.argv[1]
SCENARIO = json.loads(sys.argv[2])
API_KEY = "wrapper-secret-that-must-not-appear"
STATE = {
    "agentConstructed": 0,
    "clientDefaultCredentialHeaders": [],
    "requests": [],
}


def credential_header_names(headers):
    return sorted(name for name, value in headers.items() if value == API_KEY)


class Request:
    def __init__(self, method, url, headers=None):
        self.method = method
        self.url = url
        self.headers = dict(headers or {})


class Response:
    def __init__(self, status_code, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = dict(headers or {})

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise HTTPStatusError(f"HTTP {self.status_code}", response=self)

    async def aclose(self):
        return None


class HTTPStatusError(Exception):
    def __init__(self, message, response=None):
        super().__init__(message)
        self.response = response


class RequestError(Exception):
    pass


class TransportError(Exception):
    pass


class AsyncBaseTransport:
    pass


class AsyncHTTPTransport(AsyncBaseTransport):
    def __init__(self, **_kwargs):
        pass

    async def handle_async_request(self, request):
        STATE["requests"].append(
            {
                "method": request.method,
                "url": str(request.url),
                "credentialHeaders": credential_header_names(request.headers),
            }
        )
        if request.method == "GET":
            if SCENARIO.get("redirect"):
                return Response(302, {}, {"Location": SCENARIO["redirect"]})
            return Response(200, SCENARIO["card"])
        return Response(200, {"answer": SCENARIO.get("answer", "Approved answer")})

    async def aclose(self):
        return None


class AsyncClient:
    def __init__(self, *, transport=None, headers=None, follow_redirects=False, **_kwargs):
        self.transport = transport or AsyncHTTPTransport()
        self.default_headers = dict(headers or {})
        self.follow_redirects = follow_redirects
        STATE["clientDefaultCredentialHeaders"].append(credential_header_names(self.default_headers))

    async def __aenter__(self):
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback):
        await self.aclose()

    async def aclose(self):
        await self.transport.aclose()

    async def get(self, url, headers=None, **_kwargs):
        return await self._send("GET", url, headers)

    async def post(self, url, headers=None, **_kwargs):
        return await self._send("POST", url, headers)

    async def _send(self, method, url, headers):
        merged = dict(self.default_headers)
        merged.update(headers or {})
        response = await self.transport.handle_async_request(Request(method, url, merged))
        if self.follow_redirects and 300 <= response.status_code < 400:
            location = response.headers.get("Location", "")
            response = await self.transport.handle_async_request(Request(method, urljoin(str(url), location), merged))
        return response


def card_object(card_data):
    raw_interfaces = card_data.get("supportedInterfaces") or card_data.get("supported_interfaces") or []
    if not raw_interfaces and card_data.get("url"):
        raw_interfaces = [
            {
                "url": card_data["url"],
                "protocolBinding": card_data.get("preferredTransport", "JSONRPC"),
            }
        ]
    interfaces = [
        SimpleNamespace(
            url=entry.get("url", ""),
            protocol_binding=entry.get("protocolBinding", entry.get("protocol_binding", entry.get("transport", ""))),
        )
        for entry in raw_interfaces
    ]
    return SimpleNamespace(
        name=card_data.get("name", ""),
        description=card_data.get("description", ""),
        url=card_data.get("url", ""),
        supported_interfaces=interfaces,
    )


def parse_agent_card(card_data):
    if not card_data.get("name") or not card_data.get("description"):
        raise ValueError("invalid agent card")
    return card_object(card_data)


class AgentCard:
    @classmethod
    def model_validate(cls, card_data):
        return parse_agent_card(card_data)


class A2ACardResolver:
    def __init__(self, httpx_client, base_url):
        self.httpx_client = httpx_client
        self.base_url = base_url

    async def get_agent_card(self, relative_card_path):
        response = await self.httpx_client.get(f"{self.base_url.rstrip('/')}/{relative_card_path.lstrip('/')}")
        response.raise_for_status()
        return parse_agent_card(response.json())


class A2AAgent:
    def __init__(self, *, agent_card, http_client, **_kwargs):
        STATE["agentConstructed"] += 1
        self.agent_card = agent_card
        self.http_client = http_client

    async def run(self, _question):
        response = await self.http_client.post(self.agent_card.supported_interfaces[0].url, json={})
        return SimpleNamespace(messages=[SimpleNamespace(text=response.json()["answer"])])


httpx_module = types.ModuleType("httpx")
httpx_module.AsyncBaseTransport = AsyncBaseTransport
httpx_module.AsyncHTTPTransport = AsyncHTTPTransport
httpx_module.AsyncClient = AsyncClient
httpx_module.HTTPStatusError = HTTPStatusError
httpx_module.RequestError = RequestError
httpx_module.TransportError = TransportError

nest_asyncio_module = types.ModuleType("nest_asyncio")
nest_asyncio_module.apply = lambda: None

a2a_module = types.ModuleType("a2a")
a2a_module.__path__ = []
a2a_client_module = types.ModuleType("a2a.client")
a2a_client_module.__path__ = []
a2a_client_module.A2ACardResolver = A2ACardResolver
a2a_card_resolver_module = types.ModuleType("a2a.client.card_resolver")
a2a_card_resolver_module.parse_agent_card = parse_agent_card
a2a_types_module = types.ModuleType("a2a.types")
a2a_types_module.AgentCard = AgentCard

agent_framework_module = types.ModuleType("agent_framework")
agent_framework_module.__path__ = []
agent_framework_a2a_module = types.ModuleType("agent_framework.a2a")
agent_framework_a2a_module.A2AAgent = A2AAgent

sys.modules.update(
    {
        "httpx": httpx_module,
        "nest_asyncio": nest_asyncio_module,
        "a2a": a2a_module,
        "a2a.client": a2a_client_module,
        "a2a.client.card_resolver": a2a_card_resolver_module,
        "a2a.types": a2a_types_module,
        "agent_framework": agent_framework_module,
        "agent_framework.a2a": agent_framework_a2a_module,
    }
)

exit_code = 0
try:
    runpy.run_path(WRAPPER_PATH, run_name="__main__")
except SystemExit as exc:
    exit_code = int(exc.code or 0)

STATE["exitCode"] = exit_code
print("__CITADEL_HARNESS__" + json.dumps(STATE, sort_keys=True))
