import asyncio
import errno
import json
from typing import Literal

import aiohttp

from omnikrux.cloud import messages
from omnikrux.cloud.endpoints import same_origin

CLOUD_TIMEOUT_SECONDS = 20

# Provider codes are compared internally. User-facing reasons come only from this copy.
_PROVIDER_REASONS = {
    "invalid_client": "the application credentials were rejected",
    "invalid_grant": "the login grant was rejected",
    "AuthorizationFailed": "the login doesn't have permission",
    "SubscriptionNotFound": "the subscription wasn't found",
    "ResourceNotFound": "the resource wasn't found",
    "SERVICE_DISABLED": "the API isn't enabled",
}
_STATUS_REASONS = {
    401: "the login wasn't accepted",
    403: "the login doesn't have permission",
    404: "the resource wasn't found",
}
_CONNECTION_REASONS = {
    errno.ECONNREFUSED: "connection refused",
    10061: "connection refused",  # WinSock
}


class CloudError(Exception):
    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def cloud_error(
    cloud: str,
    action: str,
    *,
    status: int | None = None,
    reason: str | None = None,
    os_error: OSError | str | None = None,
    timed_out: bool = False,
    id_label: str = "id",
) -> CloudError:
    code = reason if reason in _PROVIDER_REASONS else None
    safe_reason = _PROVIDER_REASONS.get(
        code, _STATUS_REASONS.get(status, "the request was rejected")
    )
    if timed_out:
        message = messages.timeout(cloud, action)
    elif status is None:
        connection_reason = (
            "connection refused"
            if isinstance(os_error, ConnectionRefusedError)
            else _CONNECTION_REASONS.get(getattr(os_error, "errno", None))
        )
        if connection_reason is None:
            connection_reason = "the connection failed"
        message = messages.unreachable(cloud, action, connection_reason)
    elif status == 404:
        message = messages.not_found(cloud, action, safe_reason, id_label)
    elif status == 429:
        message = messages.throttled(cloud, action)
    elif status >= 500:
        message = messages.server_error(cloud, action, status)
    elif 300 <= status < 400:
        message = f"{cloud} returned a redirect while trying to {action}. Check the cloud endpoint."
    else:
        message = messages.refused(cloud, action, safe_reason)
    return CloudError(message, status=status, code=code)


async def _provider_code(response: aiohttp.ClientResponse, cloud: str) -> str | None:
    if not 400 <= response.status < 500:
        return None
    try:
        await response.content.readexactly(65537)
    except asyncio.IncompleteReadError as exc:
        body = exc.partial
    else:
        return None
    try:
        payload = json.loads(body)
    except (ValueError, RecursionError):
        return None
    error = payload.get("error") if isinstance(payload, dict) else None
    if cloud == "Google Cloud" and response.status == 403 and isinstance(error, dict):
        details = error.get("details")
        if isinstance(details, list) and any(
            isinstance(detail, dict)
            and detail.get("@type") == "type.googleapis.com/google.rpc.ErrorInfo"
            and detail.get("reason") == "SERVICE_DISABLED"
            for detail in details
        ):
            return "SERVICE_DISABLED"
    code = error.get("code") if isinstance(error, dict) else error
    return (
        code
        if isinstance(code, str) and code in _PROVIDER_REASONS and code != "SERVICE_DISABLED"
        else None
    )


class CloudHttp:
    def __init__(self, *, timeout: float = CLOUD_TIMEOUT_SECONDS) -> None:
        self._timeout = aiohttp.ClientTimeout(total=timeout)
        self._session: aiohttp.ClientSession | None = None

    async def json(
        self,
        method: str,
        url: str,
        *,
        cloud: str,
        action: str,
        headers: dict | None = None,
        data: dict | None = None,
        json_body: object = None,
        id_label: str = "id",
    ) -> dict:
        return await self._request(
            method,
            url,
            cloud=cloud,
            action=action,
            headers=headers,
            data=data,
            json_body=json_body,
            id_label=id_label,
            format="json",
        )

    async def text(
        self,
        method: str,
        url: str,
        *,
        cloud: str,
        action: str,
        headers: dict | None = None,
        data: dict | None = None,
        json_body: object = None,
        id_label: str = "id",
    ) -> str:
        return await self._request(
            method,
            url,
            cloud=cloud,
            action=action,
            headers=headers,
            data=data,
            json_body=json_body,
            id_label=id_label,
            format="text",
        )

    async def _request(
        self,
        method: str,
        url: str,
        *,
        cloud: str,
        action: str,
        headers: dict | None,
        data: dict | None,
        json_body: object,
        id_label: str,
        format: Literal["json", "text"],
    ):
        if not same_origin(url, url):
            raise CloudError(
                f"{cloud} has an invalid endpoint while trying to {action}. Check the cloud endpoint."
            )
        if self._session is None:
            self._session = aiohttp.ClientSession(
                timeout=self._timeout, cookie_jar=aiohttp.DummyCookieJar(), trust_env=False
            )
        try:
            async with self._session.request(
                method, url, headers=headers, data=data, json=json_body, allow_redirects=False
            ) as response:
                if not 200 <= response.status < 300:
                    raise cloud_error(
                        cloud,
                        action,
                        status=response.status,
                        reason=await _provider_code(response, cloud),
                        id_label=id_label,
                    )
                if format == "text":
                    return await response.text()
                payload = json.loads(await response.read())
                if not isinstance(payload, dict):
                    raise TypeError
                return payload
        except TimeoutError:
            raise cloud_error(cloud, action, timed_out=True) from None
        except aiohttp.ClientConnectorError as exc:
            raise cloud_error(cloud, action, os_error=exc.os_error) from None
        except aiohttp.ClientError:
            raise cloud_error(cloud, action) from None
        except (ValueError, TypeError, LookupError, RecursionError):
            raise CloudError(
                f"{cloud} sent an unreadable reply while trying to {action}. Try again in a minute."
            ) from None

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None
