"""Every alerts route, collected into one router that `monitoring/router.py` adopts."""

from fastapi import APIRouter

from omnikrux.monitoring.alerts.api import router as alerts_router
from omnikrux.monitoring.alerts.contact_points.api import router as contact_points_router
from omnikrux.monitoring.web import adopt

router = APIRouter()

adopt(contact_points_router, router)
adopt(alerts_router, router)
