"""Every route under /api/monitoring. The feature routers are included here."""

from fastapi import APIRouter, Depends

from omnikrux.monitoring.web import refuse_cross_origin

router = APIRouter(prefix="/api/monitoring", dependencies=[Depends(refuse_cross_origin)])
